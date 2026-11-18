use rusqlite::{params, Connection, OptionalExtension};
use std::collections::{HashMap, VecDeque};
use std::env;
use std::ffi::c_void;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::sync::mpsc::{self, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const CHUNK_SIZE: i32 = 32;
const MAX_CLIENTS: usize = 64;
const MAX_LINE: u64 = 4096;
const MAX_COORD: i32 = 262_000;
const CACHE_CHUNKS: usize = 24;
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(20);
type Blocks = HashMap<(i32, i32, i32), i32>;

extern "C" {
    fn create_world(
        p: i32,
        q: i32,
        callback: extern "C" fn(i32, i32, i32, i32, *mut c_void),
        arg: *mut c_void,
    );
}

extern "C" fn collect_block(x: i32, y: i32, z: i32, w: i32, arg: *mut c_void) {
    // create_world invokes this callback synchronously with the map passed below.
    unsafe { &mut *(arg as *mut Blocks) }.insert((x, y, z), w);
}

#[derive(Default)]
struct Terrain {
    chunks: HashMap<(i32, i32), Arc<Blocks>>,
    order: VecDeque<(i32, i32)>,
}

impl Terrain {
    fn chunk(&mut self, p: i32, q: i32) -> Arc<Blocks> {
        if let Some(chunk) = self.chunks.get(&(p, q)).cloned() {
            self.order.retain(|key| *key != (p, q));
            self.order.push_back((p, q));
            return chunk;
        }
        let mut blocks = Blocks::new();
        unsafe {
            create_world(
                p,
                q,
                collect_block,
                &mut blocks as *mut Blocks as *mut c_void,
            );
        }
        let blocks = Arc::new(blocks);
        self.chunks.insert((p, q), blocks.clone());
        self.order.push_back((p, q));
        if self.order.len() > CACHE_CHUNKS {
            if let Some(old) = self.order.pop_front() {
                self.chunks.remove(&old);
            }
        }
        blocks
    }
}

#[derive(Clone)]
struct Player {
    sender: SyncSender<Vec<u8>>,
    socket: Arc<TcpStream>,
    name: String,
    position: [f64; 5],
    reward_address: Option<String>,
}

struct State {
    db: Connection,
    players: HashMap<u32, Player>,
    next_id: u32,
}

struct Server {
    state: Mutex<State>,
    terrain: Mutex<Terrain>,
    reward_categories: HashMap<i32, String>,
    default_reward_category: Option<String>,
    address_prefix: String,
}

fn chunked(x: i32) -> i32 {
    x.div_euclid(CHUNK_SIZE)
}

fn send(player: &Player, data: impl Into<Vec<u8>>) {
    match player.sender.try_send(data.into()) {
        Ok(()) => {}
        Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_)) => {
            let _ = player.socket.shutdown(Shutdown::Both);
        }
    }
}

fn broadcast(state: &State, except: Option<u32>, message: &str) {
    for (id, player) in &state.players {
        if Some(*id) != except {
            send(player, message.as_bytes().to_vec());
        }
    }
}

fn open_database(path: &str) -> rusqlite::Result<Connection> {
    let db = Connection::open(path)?;
    db.busy_timeout(Duration::from_secs(10))?;
    db.execute_batch(
        "PRAGMA journal_mode=WAL;
         CREATE TABLE IF NOT EXISTS block (p INTEGER NOT NULL, q INTEGER NOT NULL, x INTEGER NOT NULL, y INTEGER NOT NULL, z INTEGER NOT NULL, w INTEGER NOT NULL);
         CREATE UNIQUE INDEX IF NOT EXISTS block_pqxyz_idx ON block (p,q,x,y,z);
         CREATE TABLE IF NOT EXISTS light (p INTEGER NOT NULL, q INTEGER NOT NULL, x INTEGER NOT NULL, y INTEGER NOT NULL, z INTEGER NOT NULL, w INTEGER NOT NULL);
         CREATE UNIQUE INDEX IF NOT EXISTS light_pqxyz_idx ON light (p,q,x,y,z);
         CREATE TABLE IF NOT EXISTS sign (p INTEGER NOT NULL, q INTEGER NOT NULL, x INTEGER NOT NULL, y INTEGER NOT NULL, z INTEGER NOT NULL, face INTEGER NOT NULL, text TEXT NOT NULL);
         CREATE UNIQUE INDEX IF NOT EXISTS sign_xyzface_idx ON sign (x,y,z,face);
         CREATE INDEX IF NOT EXISTS sign_pq_idx ON sign (p,q);
         CREATE TABLE IF NOT EXISTS mining_rewards (
           id INTEGER PRIMARY KEY, x INTEGER NOT NULL, y INTEGER NOT NULL, z INTEGER NOT NULL,
           cash_address TEXT NOT NULL, category TEXT NOT NULL, signed_tx TEXT, txid TEXT, sent_at TEXT,
           UNIQUE(x,y,z)
         );",
    )?;
    Ok(db)
}

fn valid_reward_address(address: &str, expected_prefix: &str) -> bool {
    const CHARSET: &[u8] = b"qpzry9x8gf2tvdw0s3jn54khce6mua7l";
    const GENERATORS: [u64; 5] = [
        0x98f2bc8e61,
        0x79b76d99e2,
        0xf33e5fb3c4,
        0xae2eabe2a8,
        0x1e4f43e470,
    ];
    if address.len() > 120 || address != address.to_ascii_lowercase() {
        return false;
    }
    let Some((prefix, payload)) = address.split_once(':') else {
        return false;
    };
    if prefix != expected_prefix || payload.len() < 9 {
        return false;
    }
    let Some(values) = payload
        .bytes()
        .map(|c| CHARSET.iter().position(|v| *v == c).map(|v| v as u8))
        .collect::<Option<Vec<_>>>()
    else {
        return false;
    };
    let mut checksum = 1u64;
    for value in prefix
        .bytes()
        .map(|c| c & 31)
        .chain(std::iter::once(0))
        .chain(values.iter().copied())
    {
        let top = checksum >> 35;
        checksum = ((checksum & 0x07ffffffff) << 5) ^ u64::from(value);
        for (bit, generator) in GENERATORS.iter().enumerate() {
            if (top >> bit) & 1 != 0 {
                checksum ^= generator;
            }
        }
    }
    if checksum != 1 {
        return false;
    }
    let mut acc = 0u32;
    let mut bits = 0;
    let mut decoded = Vec::new();
    for value in &values[..values.len() - 8] {
        acc = ((acc << 5) | u32::from(*value)) & 0xfff;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            decoded.push(((acc >> bits) & 255) as u8);
        }
    }
    if bits >= 5 || ((acc << (8 - bits)) & 255) != 0 || decoded.is_empty() {
        return false;
    }
    let version = decoded[0];
    let lengths = [20, 24, 28, 32, 40, 48, 56, 64];
    version & 0x80 == 0
        && matches!(version >> 3, 2 | 3)
        && decoded.len() == 1 + lengths[(version & 7) as usize]
}

fn chunk_response(server: &Server, id: u32, p: i32, q: i32, key: i64) -> rusqlite::Result<()> {
    if p.unsigned_abs() > (MAX_COORD / CHUNK_SIZE) as u32
        || q.unsigned_abs() > (MAX_COORD / CHUNK_SIZE) as u32
        || key < -1
    {
        return Ok(());
    }
    let terrain = if key == 0 {
        Some(server.terrain.lock().unwrap().chunk(p, q))
    } else {
        None
    };
    let state = server.state.lock().unwrap();
    let Some(player) = state.players.get(&id) else {
        return Ok(());
    };
    let mut output = String::new();
    if let Some(terrain) = terrain {
        for (&(x, y, z), &w) in terrain.iter() {
            output.push_str(&format!("B,{p},{q},{x},{y},{z},{w}\n"));
        }
    }
    let mut max_rowid = key.max(0);
    {
        let mut stmt = state.db.prepare_cached(
            "SELECT rowid,x,y,z,w FROM block WHERE p=?1 AND q=?2 AND rowid>?3 ORDER BY rowid",
        )?;
        let rows = stmt.query_map(params![p, q, key.max(0)], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, i32>(1)?,
                r.get::<_, i32>(2)?,
                r.get::<_, i32>(3)?,
                r.get::<_, i32>(4)?,
            ))
        })?;
        for row in rows {
            let (rowid, x, y, z, w) = row?;
            max_rowid = max_rowid.max(rowid);
            output.push_str(&format!("B,{p},{q},{x},{y},{z},{w}\n"));
        }
    }
    {
        let mut stmt = state
            .db
            .prepare_cached("SELECT x,y,z,w FROM light WHERE p=?1 AND q=?2")?;
        let rows = stmt.query_map(params![p, q], |r| {
            Ok((
                r.get::<_, i32>(0)?,
                r.get::<_, i32>(1)?,
                r.get::<_, i32>(2)?,
                r.get::<_, i32>(3)?,
            ))
        })?;
        for row in rows {
            let (x, y, z, w) = row?;
            output.push_str(&format!("L,{p},{q},{x},{y},{z},{w}\n"));
        }
    }
    {
        let mut stmt = state
            .db
            .prepare_cached("SELECT x,y,z,face,text FROM sign WHERE p=?1 AND q=?2")?;
        let rows = stmt.query_map(params![p, q], |r| {
            Ok((
                r.get::<_, i32>(0)?,
                r.get::<_, i32>(1)?,
                r.get::<_, i32>(2)?,
                r.get::<_, i32>(3)?,
                r.get::<_, String>(4)?,
            ))
        })?;
        for row in rows {
            let (x, y, z, face, text) = row?;
            output.push_str(&format!("S,{p},{q},{x},{y},{z},{face},{text}\n"));
        }
    }
    let refresh = key != -1 || !output.is_empty();
    output.push_str(&format!("K,{p},{q},{max_rowid}\n"));
    if refresh {
        output.push_str(&format!("R,{p},{q}\n"));
    }
    output.push_str(&format!("C,{p},{q}\n"));
    send(player, output.into_bytes());
    Ok(())
}

fn block_edit(server: &Server, id: u32, x: i32, y: i32, z: i32, w: i32) -> rusqlite::Result<()> {
    if x.unsigned_abs() > MAX_COORD as u32
        || z.unsigned_abs() > MAX_COORD as u32
        || !(1..=255).contains(&y)
    {
        return Ok(());
    }
    let (p, q) = (chunked(x), chunked(z));
    let default = *server
        .terrain
        .lock()
        .unwrap()
        .chunk(p, q)
        .get(&(x, y, z))
        .unwrap_or(&0);
    let mut state = server.state.lock().unwrap();
    let Some(player) = state.players.get(&id).cloned() else {
        return Ok(());
    };
    let edited: Option<i32> = state
        .db
        .query_row(
            "SELECT w FROM block WHERE p=?1 AND q=?2 AND x=?3 AND y=?4 AND z=?5",
            params![p, q, x, y, z],
            |r| r.get(0),
        )
        .optional()?;
    let previous = edited.unwrap_or(default);
    let allowed = (0..=15).contains(&w) || (17..=23).contains(&w) || (32..=67).contains(&w);
    let distance = ((player.position[0] - x as f64).powi(2)
        + (player.position[1] - y as f64).powi(2)
        + (player.position[2] - z as f64).powi(2))
    .sqrt();
    if !allowed
        || previous == 16
        || (w == 0 && previous == 0)
        || (w != 0 && previous != 0)
        || distance > 10.0
    {
        send(
            &player,
            format!("B,{p},{q},{x},{y},{z},{previous}\nR,{p},{q}\nT,Invalid block edit.\n")
                .into_bytes(),
        );
        return Ok(());
    }
    let transaction = state.db.transaction()?;
    let mut changes = Vec::new();
    for dx in -1..=1 {
        for dz in -1..=1 {
            if dx != 0 && chunked(x + dx) == p {
                continue;
            }
            if dz != 0 && chunked(z + dz) == q {
                continue;
            }
            let (np, nq) = (p + dx, q + dz);
            let value = if dx == 0 && dz == 0 { w } else { -w };
            transaction.execute(
                "INSERT OR REPLACE INTO block (p,q,x,y,z,w) VALUES (?1,?2,?3,?4,?5,?6)",
                params![np, nq, x, y, z, value],
            )?;
            changes.push(format!("B,{np},{nq},{x},{y},{z},{value}\nR,{np},{nq}\n"));
        }
    }
    if w == 0 {
        transaction.execute(
            "DELETE FROM sign WHERE x=?1 AND y=?2 AND z=?3",
            params![x, y, z],
        )?;
        if edited.is_none() && default > 0 {
            if let (Some(address), Some(category)) = (
                player.reward_address.as_ref(),
                server
                    .reward_categories
                    .get(&default)
                    .or(server.default_reward_category.as_ref()),
            ) {
                transaction.execute(
                    "INSERT OR IGNORE INTO mining_rewards (x,y,z,cash_address,category) VALUES (?1,?2,?3,?4,?5)",
                    params![x, y, z, address, category],
                )?;
            }
        }
        transaction.execute(
            "UPDATE light SET w=0 WHERE x=?1 AND y=?2 AND z=?3",
            params![x, y, z],
        )?;
    }
    transaction.commit()?;
    broadcast(&state, Some(id), &changes.concat());
    Ok(())
}

fn light_edit(server: &Server, id: u32, x: i32, y: i32, z: i32, w: i32) -> rusqlite::Result<()> {
    if x.unsigned_abs() > MAX_COORD as u32
        || z.unsigned_abs() > MAX_COORD as u32
        || !(1..=255).contains(&y)
        || !(0..=15).contains(&w)
    {
        return Ok(());
    }
    let (p, q) = (chunked(x), chunked(z));
    let default = *server
        .terrain
        .lock()
        .unwrap()
        .chunk(p, q)
        .get(&(x, y, z))
        .unwrap_or(&0);
    let state = server.state.lock().unwrap();
    let previous: i32 = state
        .db
        .query_row(
            "SELECT w FROM block WHERE p=?1 AND q=?2 AND x=?3 AND y=?4 AND z=?5",
            params![p, q, x, y, z],
            |r| r.get(0),
        )
        .optional()?
        .unwrap_or(default);
    if previous <= 0 {
        if let Some(player) = state.players.get(&id) {
            send(player, b"T,Lights must be placed on a block.\n".to_vec());
        }
        return Ok(());
    }
    state.db.execute(
        "INSERT OR REPLACE INTO light (p,q,x,y,z,w) VALUES (?1,?2,?3,?4,?5,?6)",
        params![p, q, x, y, z, w],
    )?;
    broadcast(
        &state,
        Some(id),
        &format!("L,{p},{q},{x},{y},{z},{w}\nR,{p},{q}\n"),
    );
    Ok(())
}

fn sign_edit(
    server: &Server,
    id: u32,
    x: i32,
    y: i32,
    z: i32,
    face: i32,
    text: &str,
) -> rusqlite::Result<()> {
    if x.unsigned_abs() > MAX_COORD as u32
        || z.unsigned_abs() > MAX_COORD as u32
        || !(1..=255).contains(&y)
        || !(0..=7).contains(&face)
        || text.len() > 48
    {
        return Ok(());
    }
    let (p, q) = (chunked(x), chunked(z));
    let state = server.state.lock().unwrap();
    if text.is_empty() {
        state.db.execute(
            "DELETE FROM sign WHERE x=?1 AND y=?2 AND z=?3 AND face=?4",
            params![x, y, z, face],
        )?;
    } else {
        state.db.execute(
            "INSERT OR REPLACE INTO sign (p,q,x,y,z,face,text) VALUES (?1,?2,?3,?4,?5,?6,?7)",
            params![p, q, x, y, z, face, text],
        )?;
    }
    broadcast(
        &state,
        Some(id),
        &format!("S,{p},{q},{x},{y},{z},{face},{text}\n"),
    );
    Ok(())
}

fn handle_command(server: &Server, id: u32, line: &str) -> rusqlite::Result<bool> {
    let mut parts = line.split(',');
    let command = parts.next().unwrap_or("");
    let args: Vec<&str> = parts.collect();
    match command {
        "V" if args == ["1"] => {}
        "V" => return Ok(false),
        "C" if args.len() == 2 || args.len() == 3 => {
            if let (Ok(p), Ok(q), Ok(key)) = (
                args[0].parse(),
                args[1].parse(),
                args.get(2).unwrap_or(&"0").parse(),
            ) {
                chunk_response(server, id, p, q, key)?;
            }
        }
        "B" if args.len() == 4 => {
            if let (Ok(x), Ok(y), Ok(z), Ok(w)) = (
                args[0].parse(),
                args[1].parse(),
                args[2].parse(),
                args[3].parse(),
            ) {
                block_edit(server, id, x, y, z, w)?;
            }
        }
        "L" if args.len() == 4 => {
            if let (Ok(x), Ok(y), Ok(z), Ok(w)) = (
                args[0].parse(),
                args[1].parse(),
                args[2].parse(),
                args[3].parse(),
            ) {
                light_edit(server, id, x, y, z, w)?;
            }
        }
        "S" if args.len() >= 5 => {
            if let (Ok(x), Ok(y), Ok(z), Ok(face)) = (
                args[0].parse(),
                args[1].parse(),
                args[2].parse(),
                args[3].parse(),
            ) {
                sign_edit(server, id, x, y, z, face, &args[4..].join(","))?;
            }
        }
        "P" if args.len() == 5 => {
            let values: Option<Vec<f64>> = args
                .iter()
                .map(|s| {
                    s.parse::<f64>()
                        .ok()
                        .filter(|v| v.is_finite() && v.abs() <= f64::from(MAX_COORD))
                })
                .collect();
            if let Some(values) = values {
                let mut state = server.state.lock().unwrap();
                if let Some(player) = state.players.get_mut(&id) {
                    player.position.copy_from_slice(&values);
                    broadcast(
                        &state,
                        Some(id),
                        &format!(
                            "P,{id},{},{},{},{},{}\n",
                            values[0], values[1], values[2], values[3], values[4]
                        ),
                    );
                }
            }
        }
        "T" => {
            let text = args.join(",");
            if text.len() > 256 {
                return Ok(true);
            }
            let mut state = server.state.lock().unwrap();
            let Some(player) = state.players.get(&id).cloned() else {
                return Ok(true);
            };
            if let Some(name) = text.strip_prefix("/nick ") {
                if !name.is_empty()
                    && name.len() <= 24
                    && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
                {
                    state.players.get_mut(&id).unwrap().name = name.to_string();
                    broadcast(&state, None, &format!("N,{id},{name}\n"));
                }
            } else if text == "/list" {
                let names = state
                    .players
                    .values()
                    .map(|p| p.name.as_str())
                    .collect::<Vec<_>>()
                    .join(", ");
                send(&player, format!("T,Players: {names}\n").into_bytes());
            } else if text == "/spawn" {
                state.players.get_mut(&id).unwrap().position = [0.0; 5];
                send(&player, format!("U,{id},0,0,0,0,0\n").into_bytes());
                broadcast(&state, Some(id), &format!("P,{id},0,0,0,0,0\n"));
            } else if text.starts_with('/') {
                send(&player, b"T,Commands: /nick NAME, /list, /spawn\n".to_vec());
            } else {
                broadcast(&state, None, &format!("T,{}> {text}\n", player.name));
            }
        }
        "A" => {}
        "W" if args.len() == 1 => {
            let address = args[0].to_ascii_lowercase();
            if valid_reward_address(&address, &server.address_prefix) && args[0] == address {
                let mut state = server.state.lock().unwrap();
                if let Some(player) = state.players.get_mut(&id) {
                    if player.reward_address.is_none() {
                        player.reward_address = Some(address);
                        send(player, b"T,Mining reward address connected.\n".to_vec());
                    }
                }
            } else {
                let state = server.state.lock().unwrap();
                if let Some(player) = state.players.get(&id) {
                    send(
                        player,
                        b"T,Invalid token-aware mining reward address.\n".to_vec(),
                    );
                }
            }
        }
        _ => {}
    }
    Ok(true)
}

fn write_client(mut stream: TcpStream, receiver: mpsc::Receiver<Vec<u8>>, interval: Duration) {
    loop {
        let data = match receiver.recv_timeout(interval) {
            Ok(data) => data,
            Err(mpsc::RecvTimeoutError::Timeout) => b"H\n".to_vec(),
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        };
        if let Err(error) = stream.write_all(&data) {
            eprintln!("client write failed: {error}");
            break;
        }
    }
    let _ = stream.shutdown(Shutdown::Both);
}

fn serve_client(server: Arc<Server>, stream: TcpStream) -> io::Result<()> {
    stream.set_nodelay(true)?;
    let reader = stream.try_clone()?;
    let socket = Arc::new(stream.try_clone()?);
    let (sender, receiver) = mpsc::sync_channel::<Vec<u8>>(64);
    let id = {
        let mut state = server.state.lock().unwrap();
        if state.players.len() >= MAX_CLIENTS {
            return Ok(());
        }
        let id = state.next_id;
        state.next_id = state
            .next_id
            .checked_add(1)
            .ok_or_else(|| io::Error::other("player IDs exhausted"))?;
        let player = Player {
            sender,
            socket,
            name: format!("guest{id}"),
            position: [0.0; 5],
            reward_address: None,
        };
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        send(
            &player,
            format!("U,{id},0,0,0,0,0\nE,{now},600\nT,Welcome to NetCraft!\n").into_bytes(),
        );
        for (other_id, other) in &state.players {
            let [x, y, z, rx, ry] = other.position;
            send(
                &player,
                format!(
                    "P,{other_id},{x},{y},{z},{rx},{ry}\nN,{other_id},{}\n",
                    other.name
                )
                .into_bytes(),
            );
        }
        broadcast(
            &state,
            None,
            &format!("P,{id},0,0,0,0,0\nN,{id},{}\n", player.name),
        );
        state.players.insert(id, player);
        id
    };
    thread::spawn(move || write_client(stream, receiver, HEARTBEAT_INTERVAL));
    let mut reader = BufReader::new(reader);
    let result = (|| -> io::Result<()> {
        loop {
            let mut line = Vec::new();
            let n = reader
                .by_ref()
                .take(MAX_LINE + 1)
                .read_until(b'\n', &mut line)?;
            if n == 0 {
                break;
            }
            if n as u64 > MAX_LINE || !line.ends_with(b"\n") {
                break;
            }
            let Ok(line) = std::str::from_utf8(&line) else {
                break;
            };
            match handle_command(&server, id, line.trim_end_matches(['\r', '\n'])) {
                Ok(true) => {}
                Ok(false) => break,
                Err(error) => {
                    eprintln!("client {id} command failed: {error}");
                    break;
                }
            }
        }
        Ok(())
    })();
    let mut state = server.state.lock().unwrap();
    state.players.remove(&id);
    broadcast(&state, None, &format!("D,{id}\n"));
    result
}

fn reward_configuration() -> Result<(Option<String>, HashMap<i32, String>), String> {
    let valid_category = |s: &str| s.len() == 64 && s.bytes().all(|c| c.is_ascii_hexdigit());
    let default = env::var("BCH_REWARD_CATEGORY")
        .ok()
        .filter(|s| !s.is_empty());
    if default.as_ref().is_some_and(|s| !valid_category(s)) {
        return Err("BCH_REWARD_CATEGORY must be 64 hexadecimal characters".into());
    }
    let mut categories = HashMap::new();
    let mapping = env::var("NETCRAFT_BLOCK_CATEGORIES").unwrap_or_default();
    for pair in mapping.split(',').filter(|s| !s.trim().is_empty()) {
        let Some((item, category)) = pair.trim().split_once('=') else {
            return Err("NETCRAFT_BLOCK_CATEGORIES entries must be block_id=category".into());
        };
        let id: i32 = item.trim().parse().map_err(|_| "invalid block ID")?;
        if !(1..=255).contains(&id) || !valid_category(category.trim()) {
            return Err("Invalid block ID or token category in NETCRAFT_BLOCK_CATEGORIES".into());
        }
        if categories
            .insert(id, category.trim().to_ascii_lowercase())
            .is_some()
        {
            return Err("Duplicate block ID in NETCRAFT_BLOCK_CATEGORIES".into());
        }
    }
    for id in 1..=255 {
        let variable = format!("NETCRAFT_BLOCK_CATEGORY_{id}");
        if let Ok(value) = env::var(&variable) {
            if value.is_empty() {
                continue;
            }
            if !valid_category(&value) {
                return Err(format!("{variable} must be 64 hexadecimal characters"));
            }
            if categories.insert(id, value.to_ascii_lowercase()).is_some() {
                return Err(format!(
                    "{variable} duplicates an entry in NETCRAFT_BLOCK_CATEGORIES"
                ));
            }
        }
    }
    Ok((default.map(|s| s.to_ascii_lowercase()), categories))
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let address = env::var("NETCRAFT_LISTEN").unwrap_or_else(|_| "0.0.0.0:4080".into());
    let database = env::var("NETCRAFT_DB").unwrap_or_else(|_| "craft.db".into());
    let (mut default_reward_category, mut reward_categories) = reward_configuration()?;
    match env::var("NETCRAFT_MINING_REWARDS_ENABLED").as_deref() {
        Ok("true") => eprintln!(
            "Warning: mining rewards are enabled without player authentication or a payout cap"
        ),
        Ok("false") | Err(env::VarError::NotPresent) => {
            default_reward_category = None;
            reward_categories.clear();
        }
        _ => return Err("NETCRAFT_MINING_REWARDS_ENABLED must be true or false".into()),
    }
    let address_prefix = match env::var("BCH_NETWORK")
        .unwrap_or_else(|_| "mainnet".into())
        .as_str()
    {
        "mainnet" => "bitcoincash",
        "chipnet" => "bchtest",
        _ => return Err("BCH_NETWORK must be mainnet or chipnet".into()),
    }
    .to_string();
    let server = Arc::new(Server {
        state: Mutex::new(State {
            db: open_database(&database)?,
            players: HashMap::new(),
            next_id: 1,
        }),
        terrain: Mutex::new(Terrain::default()),
        reward_categories,
        default_reward_category,
        address_prefix,
    });
    let listener = TcpListener::bind(&address)?;
    eprintln!("NetCraft listening on {address}, database {database}");
    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                let server = server.clone();
                thread::spawn(move || {
                    if let Err(error) = serve_client(server, stream) {
                        eprintln!("client failed: {error}");
                    }
                });
            }
            Err(error) => eprintln!("accept failed: {error}"),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> (Server, mpsc::Receiver<Vec<u8>>, mpsc::Receiver<Vec<u8>>) {
        let server = Server {
            state: Mutex::new(State {
                db: open_database(":memory:").unwrap(),
                players: HashMap::new(),
                next_id: 3,
            }),
            terrain: Mutex::new(Terrain::default()),
            reward_categories: HashMap::from([(6, "a".repeat(64))]),
            default_reward_category: Some("b".repeat(64)),
            address_prefix: "bitcoincash".into(),
        };
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let mut receivers = Vec::new();
        for id in 1..=2 {
            let socket = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
            let (_peer, _) = listener.accept().unwrap();
            let (sender, receiver) = mpsc::sync_channel(64);
            server.state.lock().unwrap().players.insert(
                id,
                Player {
                    sender,
                    socket: Arc::new(socket),
                    name: format!("guest{id}"),
                    position: [0.0, 1.0, 0.0, 0.0, 0.0],
                    reward_address: None,
                },
            );
            receivers.push(receiver);
        }
        let second = receivers.pop().unwrap();
        (server, receivers.pop().unwrap(), second)
    }

    #[test]
    fn token_address_checks_checksum_network_and_type() {
        let address = "bitcoincash:zqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqweyg7usz";
        assert!(valid_reward_address(address, "bitcoincash"));
        assert!(!valid_reward_address(address, "bchtest"));
        assert!(!valid_reward_address(
            "bitcoincash:zqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqweyg7usq",
            "bitcoincash"
        ));
        assert!(!valid_reward_address(
            "bitcoincash:qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqfnhks603",
            "bitcoincash"
        ));
    }

    #[test]
    fn natural_block_reward_is_atomic_and_once_only() {
        let (server, _first, second) = setup();
        let address = "bitcoincash:zqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqweyg7usz";
        handle_command(&server, 1, &format!("W,{address}")).unwrap();
        assert_eq!(
            *server
                .terrain
                .lock()
                .unwrap()
                .chunk(0, 0)
                .get(&(0, 1, 0))
                .unwrap(),
            6
        );
        block_edit(&server, 1, 0, 1, 0, 0).unwrap();
        let update = String::from_utf8(second.try_recv().unwrap()).unwrap();
        assert!(update.contains("B,0,0,0,1,0,0\n"));
        assert!(update.contains("B,-1,-1,0,1,0,0\n"));
        block_edit(&server, 1, 0, 1, 0, 6).unwrap();
        block_edit(&server, 1, 0, 1, 0, 0).unwrap();
        let state = server.state.lock().unwrap();
        let (count, category, recipient): (i64, String, String) = state
            .db
            .query_row(
                "SELECT count(*),category,cash_address FROM mining_rewards",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(count, 1);
        assert_eq!(category, "a".repeat(64));
        assert_eq!(recipient, address);
        drop(state);
        chunk_response(&server, 1, 0, 0, -1).unwrap();
        let output = _first.try_iter().last().unwrap();
        let output = String::from_utf8(output).unwrap();
        assert!(output.contains("B,0,0,0,1,0,0\n"));
        assert!(output.contains("R,0,0\nC,0,0\n"));
        assert_eq!(chunked(-1), -1);
    }

    #[test]
    fn extended_block_types_can_be_placed() {
        let (server, _first, second) = setup();
        server
            .state
            .lock()
            .unwrap()
            .players
            .get_mut(&1)
            .unwrap()
            .position[1] = 100.0;
        block_edit(&server, 1, 0, 100, 0, 67).unwrap();
        let output = String::from_utf8(second.try_recv().unwrap()).unwrap();
        assert!(output.contains("B,0,0,0,100,0,67\n"));
    }

    #[test]
    fn movement_and_block_edits_are_broadcast_without_receiver_input() {
        let (server, first, second) = setup();
        handle_command(&server, 1, "P,0,100,0,0,0").unwrap();
        let position = String::from_utf8(second.try_recv().unwrap()).unwrap();
        assert_eq!(position, "P,1,0,100,0,0,0\n");
        block_edit(&server, 1, 0, 100, 0, 6).unwrap();
        let placed = String::from_utf8(second.try_recv().unwrap()).unwrap();
        assert!(placed.contains("B,0,0,0,100,0,6\nR,0,0\n"));
        block_edit(&server, 1, 0, 100, 0, 0).unwrap();
        let mined = String::from_utf8(second.try_recv().unwrap()).unwrap();
        assert!(mined.contains("B,0,0,0,100,0,0\nR,0,0\n"));
        assert!(first.try_recv().is_err());
    }

    #[test]
    fn empty_local_baseline_chunk_does_not_trigger_a_refresh() {
        let (server, first, _) = setup();
        chunk_response(&server, 1, 0, 0, -1).unwrap();
        let output = String::from_utf8(first.try_recv().unwrap()).unwrap();
        assert_eq!(output, "K,0,0,0\nC,0,0\n");
        chunk_response(&server, 1, 0, 0, 0).unwrap();
        let output = String::from_utf8(first.try_recv().unwrap()).unwrap();
        assert!(output.contains("R,0,0\nC,0,0\n"));
    }

    #[test]
    fn idle_client_receives_heartbeat_and_normal_messages() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let mut client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        client
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let (stream, _) = listener.accept().unwrap();
        let (sender, receiver) = mpsc::sync_channel(2);
        let writer =
            thread::spawn(move || write_client(stream, receiver, Duration::from_millis(20)));
        let mut reader = BufReader::new(&mut client);
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        assert_eq!(line, "H\n");
        sender.send(b"T,hello\n".to_vec()).unwrap();
        loop {
            line.clear();
            reader.read_line(&mut line).unwrap();
            if line != "H\n" {
                break;
            }
        }
        assert_eq!(line, "T,hello\n");
        drop(sender);
        writer.join().unwrap();
    }
}
