use rusqlite::{params, Connection, OptionalExtension};
use std::collections::{BTreeSet, HashMap, HashSet, VecDeque};
use std::env;
use std::ffi::c_void;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream, ToSocketAddrs};
use std::sync::mpsc::{self, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

mod flow;

const CHUNK_SIZE: i32 = 32;
const WORLD_MIN_Y: i32 = -24;
const WORLD_MAX_Y: i32 = 255;
const BEDROCK: i32 = 65;
const MAX_CLIENTS: usize = 64;
const MAX_LINE: u64 = 4096;
const MAX_COORD: i32 = 262_000;
const CACHE_CHUNKS: usize = 24;
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(20);
const ANIMAL_SPAWNS_PER_TICK: usize = 64;
const ANIMAL_MOVES_PER_TICK: usize = 128;
const MEMPOOL_POLL: Duration = Duration::from_secs(10);
const MINA_ORE: i32 = 83;
const REDSTONE_ORE: i32 = 49;
const GOLD_ORE: i32 = 70;
const LAPIS_LAZULI_ORE: i32 = 73;
const TRACKED_ORES: [i32; 3] = [MINA_ORE, LAPIS_LAZULI_ORE, REDSTONE_ORE];
const ANIMAL_TICK: Duration = Duration::from_secs(1);
const DAY_LENGTH: u64 = 600;
const PLAYER_LIVES: u8 = 10;
const ATTACK_INTERVAL: u64 = 2;
const ZOMBIE_SPEED: f64 = 1.3;
// Central sky park footprint from builder.py; lower terrain remains spawnable.
const PARK_FLOOR: i32 = 180;
type Blocks = HashMap<(i32, i32, i32), i32>;

extern "C" {
    fn create_world(
        p: i32,
        q: i32,
        callback: extern "C" fn(i32, i32, i32, i32, *mut c_void),
        arg: *mut c_void,
    );
    fn world_stream(x: i32, z: i32, bottom: *mut i32, top: *mut i32) -> i32;
    fn world_stream_direction(x: i32) -> i32;
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
    guest_id: Option<String>,
    inventory: [u32; 256],
    lives: u8,
    last_attack_tick: Option<u64>,
    last_pickaxe: Option<Instant>,
}

struct State {
    db: Connection,
    players: HashMap<u32, Player>,
    next_id: u32,
    animals: Vec<Animal>,
    mempool: BTreeSet<String>,
    next_animal_id: u32,
    animal_tick: u64,
    animal_cursor: usize,
    night: Option<bool>,
    flows: HashMap<flow::Region, flow::Flow>,
}

#[derive(Clone, Debug)]
struct Animal {
    id: u32,
    txid: String,
    x: f64,
    y: f64,
    z: f64,
    heading: u8,
    pacified: bool,
}

impl Animal {
    fn message(&self) -> String {
        format!(
            "M,{},{:.2},{:.2},{:.2},{},{}...{},{}\n",
            self.id,
            self.x,
            self.y,
            self.z,
            self.heading,
            &self.txid[..6],
            &self.txid[58..],
            u8::from(self.pacified)
        )
    }
}

struct Server {
    state: Mutex<State>,
    terrain: Mutex<Terrain>,
    reward_categories: HashMap<i32, String>,
    address_prefix: String,
    reward_wake: Option<SyncSender<(i64, Player)>>,
}

fn start_reward_wake() -> Result<Option<SyncSender<(i64, Player)>>, String> {
    let target = env::var("NETCRAFT_REWARD_API").unwrap_or_default();
    let secret = env::var("NETCRAFT_REWARD_WAKE_SECRET").unwrap_or_default();
    if target.is_empty() && secret.is_empty() {
        return Ok(None);
    }
    if target.is_empty() || secret.is_empty() || secret.bytes().any(|b| !(33..=126).contains(&b)) {
        return Err("Set NETCRAFT_REWARD_API and a printable NETCRAFT_REWARD_WAKE_SECRET".into());
    }
    let (sender, receiver) = mpsc::sync_channel::<(i64, Player)>(1024);
    thread::spawn(move || {
        while let Ok((reward_id, player)) = receiver.recv() {
            let result = (|| -> io::Result<()> {
                let address = target
                    .to_socket_addrs()?
                    .next()
                    .ok_or_else(|| io::Error::other("reward API address did not resolve"))?;
                let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(2))?;
                stream.set_read_timeout(Some(Duration::from_secs(95)))?;
                stream.set_write_timeout(Some(Duration::from_secs(2)))?;
                write!(stream, "POST /api/internal/netcraft-mining-reward/{reward_id} HTTP/1.1\r\nHost: {target}\r\nAuthorization: Bearer {secret}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")?;
                let mut response = String::new();
                BufReader::new(stream).read_line(&mut response)?;
                if !response.starts_with("HTTP/1.1 204 ") && !response.starts_with("HTTP/1.0 204 ")
                    && !response.starts_with("HTTP/1.1 202 ") && !response.starts_with("HTTP/1.0 202 ")
                {
                    let status = response.split_whitespace().nth(1).unwrap_or("invalid");
                    return Err(io::Error::other(format!("mining payout API returned HTTP {status}")));
                }
                Ok(())
            })();
            if let Err(error) = result {
                eprintln!("Mining reward {reward_id} failed ({error}); check the payout backend");
                if let Some(address) = player.reward_address.as_deref() {
                    send(&player, format!("F,{address}\n"));
                }
            }
        }
    });
    Ok(Some(sender))
}

fn read_mempool_response(response: impl Read) -> io::Result<BTreeSet<String>> {
    let invalid = || io::Error::other("invalid NetCraft mempool response");
    let mut response = BufReader::new(response.take(64 * 1024 * 1024 + 1));
    let mut line = String::new();
    response.read_line(&mut line)?;
    if !line.starts_with("HTTP/1.1 200 ") && !line.starts_with("HTTP/1.0 200 ") {
        return Err(io::Error::other(
            "NetCraft mempool endpoint did not return HTTP 200",
        ));
    }
    let mut length = None;
    loop {
        line.clear();
        if response.read_line(&mut line)? == 0 {
            return Err(invalid());
        }
        if line == "\r\n" {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            if name.eq_ignore_ascii_case("content-length") {
                length = value.trim().parse::<usize>().ok();
            }
        }
    }
    let remaining = length
        .filter(|n| *n <= 64 * 1024 * 1024 && n % 65 == 0)
        .ok_or_else(invalid)?
        / 65;
    let mut txids = BTreeSet::new();
    let mut record = [0; 65];
    for _ in 0..remaining {
        response.read_exact(&mut record)?;
        if record[64] != b'\n' || !record[..64].iter().all(u8::is_ascii_hexdigit) {
            return Err(invalid());
        }
        txids.insert(String::from_utf8_lossy(&record[..64]).to_ascii_lowercase());
    }
    Ok(txids)
}

fn poll_mempool(target: &str, secret: &str) -> io::Result<BTreeSet<String>> {
    let address = target
        .to_socket_addrs()?
        .next()
        .ok_or_else(|| io::Error::other("NetCraft backend address did not resolve"))?;
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(2))?;
    stream.set_read_timeout(Some(Duration::from_secs(35)))?;
    stream.set_write_timeout(Some(Duration::from_secs(2)))?;
    write!(stream, "GET /api/internal/netcraft-mempool HTTP/1.1\r\nHost: {target}\r\nAuthorization: Bearer {secret}\r\nConnection: close\r\n\r\n")?;
    read_mempool_response(stream)
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

fn advance_flows(state: &mut State) {
    let mut updates = String::new();
    state.flows.retain(|_, flow| flow.advance(&mut updates));
    if !updates.is_empty() {
        broadcast(state, None, &updates);
    }
}

fn animal_ground(
    terrain: &mut Terrain,
    db: &Connection,
    x: i32,
    z: i32,
) -> rusqlite::Result<Option<i32>> {
    if x.abs() >= MAX_COORD || z.abs() >= MAX_COORD {
        return Ok(None);
    }
    let (p, q) = (chunked(x), chunked(z));
    let blocks = terrain.chunk(p, q);
    let mut edits = HashMap::new();
    let mut stmt =
        db.prepare_cached("SELECT y,w FROM block WHERE p=?1 AND q=?2 AND x=?3 AND z=?4")?;
    for row in stmt.query_map(params![p, q, x, z], |r| {
        Ok((r.get::<_, i32>(0)?, r.get::<_, i32>(1)?))
    })? {
        let (y, w) = row?;
        edits.insert(y, w);
    }
    for y in (1..=254).rev() {
        let w = edits
            .get(&y)
            .copied()
            .unwrap_or_else(|| *blocks.get(&(x, y, z)).unwrap_or(&0));
        if w == 0 || w == 16 || (17..=23).contains(&w) {
            continue;
        }
        return Ok(if matches!(w, 1 | 2 | 6 | 7 | 9 | 11) {
            Some(y)
        } else {
            None
        });
    }
    Ok(None)
}

fn hit_animal(
    server: &Server,
    player_id: u32,
    animal_id: u32,
    seconds: u64,
    now: Instant,
) -> rusqlite::Result<()> {
    if !is_night(seconds) {
        return Ok(());
    }
    let mut terrain = server.terrain.lock().unwrap();
    let mut state = server.state.lock().unwrap();
    let Some(player) = state.players.get_mut(&player_id) else {
        return Ok(());
    };
    if player.last_pickaxe.is_some_and(|last| now.duration_since(last) < Duration::from_millis(250)) {
        return Ok(());
    }
    player.last_pickaxe = Some(now);
    let [x, y, z, rx, ry] = player.position;
    let Some(index) = state.animals.iter().position(|a| a.id == animal_id && !a.pacified) else {
        return Ok(());
    };
    let animal = &state.animals[index];
    let (ax, ay, az) = (animal.x, animal.y, animal.z);
    let (vx, vy, vz) = (
        (rx - std::f64::consts::FRAC_PI_2).cos() * ry.cos(),
        ry.sin(),
        (rx - std::f64::consts::FRAC_PI_2).sin() * ry.cos(),
    );
    let mut previous = None;
    for step in 0..=128 {
        let distance = f64::from(step) / 32.0;
        let (px, py, pz) = (x + vx * distance, y + vy * distance, z + vz * distance);
        let block = (px.round() as i32, py.round() as i32, pz.round() as i32);
        if previous != Some(block) {
            previous = Some(block);
            let (bx, by, bz) = block;
            let (p, q) = (chunked(bx), chunked(bz));
            let edited: Option<i32> = state.db.query_row(
                "SELECT w FROM block WHERE p=?1 AND q=?2 AND x=?3 AND y=?4 AND z=?5",
                params![p, q, bx, by, bz],
                |row| row.get(0),
            ).optional()?;
            let w = edited.unwrap_or_else(|| *terrain.chunk(p, q).get(&block).unwrap_or(&0));
            if w > 0 {
                break;
            }
        }
        if (px - ax).abs() <= 0.8 && (pz - az).abs() <= 0.8 && py >= ay && py <= ay + 2.1 {
            state.animals[index].pacified = true;
            broadcast(&state, None, &state.animals[index].message());
            send(&state.players[&player_id], b"ZH\n".to_vec());
            return Ok(());
        }
    }
    Ok(())
}

fn is_night(seconds: u64) -> bool {
    let time = seconds % DAY_LENGTH;
    time < DAY_LENGTH / 4 || time >= DAY_LENGTH * 85 / 100
}

fn move_animal(
    animal: &mut Animal,
    terrain: &mut Terrain,
    db: &Connection,
    dx: f64,
    dz: f64,
) -> rusqlite::Result<bool> {
    let (x, z) = (animal.x + dx, animal.z + dz);
    if let Some(y) = animal_ground(terrain, db, x.round() as i32, z.round() as i32)? {
        let feet = f64::from(y) + 0.5;
        if (feet - animal.y).abs() <= 1.0 {
            (animal.x, animal.y, animal.z) = (x, feet, z);
            return Ok(true);
        }
    }
    Ok(false)
}

fn is_sky_park(x: i32, y: i32, z: i32) -> bool {
    (-28..=28).contains(&x) && (-25..=28).contains(&z) && y >= PARK_FLOOR
}

fn world_time() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn update_animals(server: &Server) -> rusqlite::Result<()> {
    update_animals_at(server, world_time())
}

fn update_animals_at(server: &Server, seconds: u64) -> rusqlite::Result<()> {
    let mut terrain = server.terrain.lock().unwrap();
    let mut state = server.state.lock().unwrap();
    state.animal_tick += 1;
    let tick = state.animal_tick;
    let night = is_night(seconds);
    if state.night != Some(night) {
        state.night = Some(night);
        broadcast(&state, None, &format!("ZN,{}\n", u8::from(night)));
        if !night {
            let mut updates = String::new();
            for animal in &mut state.animals {
                if animal.pacified {
                    animal.pacified = false;
                    updates.push_str(&animal.message());
                }
            }
            if !updates.is_empty() {
                broadcast(&state, None, &updates);
            }
        }
    }
    let positions: Vec<_> = state
        .players
        .values()
        .map(|p| p.position)
        .filter(|p| p[1] > 1.0)
        .collect();
    let mut removed = String::new();
    let State {
        animals, mempool, ..
    } = &mut *state;
    animals.retain(|a| {
        let nearby = positions
            .iter()
            .any(|p| (p[0] - a.x).powi(2) + (p[2] - a.z).powi(2) < 64.0 * 64.0);
        let keep = nearby && mempool.contains(&a.txid);
        if !keep {
            removed.push_str(&format!("MD,{}\n", a.id));
        }
        keep
    });
    if !removed.is_empty() {
        broadcast(&state, None, &removed);
    }

    let mut updates = String::new();
    let count = state.animals.len();
    let start = state.animal_cursor;
    let State { animals, db, .. } = &mut *state;
    for offset in 0..count.min(ANIMAL_MOVES_PER_TICK) {
        let animal = &mut animals[(start + offset) % count];
        let target = if night && !animal.pacified {
            positions
                .iter()
                .min_by(|a, b| {
                    let distance = |p: &&[f64; 5]| {
                        (p[0] - animal.x).powi(2)
                            + (p[1] - 1.5 - animal.y).powi(2)
                            + (p[2] - animal.z).powi(2)
                    };
                    distance(a).total_cmp(&distance(b))
                })
        } else {
            None
        };
        if let Some(target) = target {
            let dx = target[0] - animal.x;
            let dz = target[2] - animal.z;
            let distance = dx.hypot(dz);
            if distance > 0.001 {
                animal.heading = if dx.abs() > dz.abs() {
                    if dx > 0.0 {
                        1
                    } else {
                        3
                    }
                } else if dz > 0.0 {
                    2
                } else {
                    0
                };
                let stop = if (target[1] - 1.5 - animal.y).abs() < 1.0 {
                    1.0
                } else {
                    0.0
                };
                let travel = (distance - stop).clamp(0.0, ZOMBIE_SPEED);
                let steps = (travel / 0.5).ceil() as u32;
                for _ in 0..steps {
                    // Check each step so a fast move cannot skip a stair or a wall.
                    let fraction = travel / (distance * f64::from(steps));
                    let (sx, sz) = (dx * fraction, dz * fraction);
                    if !move_animal(animal, &mut terrain, db, sx, sz)?
                        && !(sx != 0.0 && sz != 0.0
                            && (move_animal(animal, &mut terrain, db, sx, 0.0)?
                                || move_animal(animal, &mut terrain, db, 0.0, sz)?))
                    {
                        break;
                    }
                }
            }
        } else {
            if (tick + u64::from(animal.id)) % 5 == 0 {
                animal.heading = ((tick / 5 + u64::from(animal.id) * 3) % 4) as u8;
            }
            let (dx, dz) = match animal.heading {
                0 => (0.0, -0.6),
                1 => (0.6, 0.0),
                2 => (0.0, 0.6),
                _ => (-0.6, 0.0),
            };
            if !move_animal(animal, &mut terrain, db, dx, dz)? {
                animal.heading = (animal.heading + 1) % 4;
            }
        }
        updates.push_str(&animal.message());
    }
    state.animal_cursor = (start + ANIMAL_MOVES_PER_TICK) % count.max(1);

    if night {
        let attackers: Vec<_> = state.animals.iter()
            .filter(|a| !a.pacified)
            .map(|a| (a.x, a.y, a.z))
            .collect();
        let mut hit = Vec::new();
        for (id, player) in &state.players {
            let [x, y, z, _, _] = player.position;
            if y <= 1.0
                || player
                    .last_attack_tick
                    .is_some_and(|last| tick - last < ATTACK_INTERVAL)
            {
                continue;
            }
            for &(ax, ay, az) in &attackers {
                if (x - ax).hypot(z - az) <= 1.3
                    && (y - ay).abs() <= 2.5
                    && animal_ground(
                        &mut terrain,
                        &state.db,
                        ((x + ax) / 2.0).round() as i32,
                        ((z + az) / 2.0).round() as i32,
                    )?
                    .is_some_and(|ground| f64::from(ground) <= ay.floor())
                {
                    hit.push(*id);
                    break;
                }
            }
        }
        let mut respawned = Vec::new();
        for id in hit {
            if let Some(player) = state.players.get_mut(&id) {
                player.last_attack_tick = Some(tick);
                player.lives -= 1;
                if player.lives == 0 {
                    player.position = [0.0; 5];
                    player.lives = PLAYER_LIVES;
                    player.inventory.fill(0);
                    send(
                        player,
                        b"ZD\nT,You lost all your lives and respawned without your mined blocks.\n".to_vec(),
                    );
                    respawned.push(id);
                }
                send(player, format!("HP,{}\n", player.lives));
            }
        }
        for id in respawned {
            broadcast(&state, Some(id), &format!("P,{id},0,0,0,0,0\n"));
        }
    }

    if !positions.is_empty() && state.animals.len() < state.mempool.len() {
        let active: HashSet<_> = state.animals.iter().map(|a| a.txid.as_str()).collect();
        let missing: Vec<_> = state
            .mempool
            .iter()
            .filter(|txid| !active.contains(txid.as_str()))
            .take(ANIMAL_SPAWNS_PER_TICK)
            .cloned()
            .collect();
        for (index, txid) in missing.into_iter().enumerate() {
            let p = positions[(tick as usize + index) % positions.len()];
            let id = state.next_animal_id;
            let angle = ((tick * 7 + u64::from(id) * 13 + index as u64) % 32) as f64
                * std::f64::consts::TAU
                / 32.0;
            let radius = 12.0 + 4.0 * (((id - 1) / 32) % 9) as f64;
            let x = (p[0] + angle.cos() * radius).round() as i32;
            let z = (p[2] + angle.sin() * radius).round() as i32;
            if let Some(y) = animal_ground(&mut terrain, &state.db, x, z)? {
                if is_sky_park(x, y, z) {
                    continue;
                }
                state.next_animal_id = state.next_animal_id.wrapping_add(1).max(1);
                let animal = Animal {
                    id,
                    txid,
                    x: f64::from(x),
                    y: f64::from(y) + 0.5,
                    z: f64::from(z),
                    heading: (id % 4) as u8,
                    pacified: false,
                };
                updates.push_str(&animal.message());
                state.animals.push(animal);
            }
        }
    }
    if !updates.is_empty() {
        broadcast(&state, None, &updates);
    }
    Ok(())
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
           cash_address TEXT NOT NULL, category TEXT NOT NULL, signed_tx TEXT, txid TEXT, sent_at TEXT, player_name TEXT,
           UNIQUE(x,y,z)
         );
         CREATE TABLE IF NOT EXISTS mina_mining_progress (
           cash_address TEXT NOT NULL, category TEXT NOT NULL,
           blocks INTEGER NOT NULL CHECK(blocks >= 0 AND blocks < 10),
           PRIMARY KEY(cash_address, category)
         );
         CREATE TABLE IF NOT EXISTS guest_mining_progress (
           guest_id TEXT NOT NULL, category TEXT NOT NULL,
           blocks INTEGER NOT NULL CHECK(blocks >= 0 AND blocks < 10),
           unlocked INTEGER NOT NULL DEFAULT 0,
           last_x INTEGER, last_y INTEGER, last_z INTEGER,
           PRIMARY KEY(guest_id, category)
         );
         CREATE TABLE IF NOT EXISTS guest_mining_rewards (
           guest_id TEXT NOT NULL, category TEXT NOT NULL,
           x INTEGER NOT NULL, y INTEGER NOT NULL, z INTEGER NOT NULL, player_name TEXT,
           UNIQUE(x,y,z)
         );
         CREATE TABLE IF NOT EXISTS mining_totals (
           name TEXT PRIMARY KEY, total INTEGER NOT NULL CHECK(total >= 0)
         );
         CREATE TABLE IF NOT EXISTS ore_scores (
           miner TEXT NOT NULL, ore INTEGER NOT NULL, player_name TEXT NOT NULL,
           blocks INTEGER NOT NULL CHECK(blocks > 0), PRIMARY KEY(miner, ore)
         );
         INSERT OR IGNORE INTO mining_totals (name, total) VALUES ('mina_ore', 0);",
    )?;
    let columns = {
        let mut statement = db.prepare("PRAGMA table_info(mining_rewards)")?;
        let names = statement
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        names
    };
    for column in ["x", "y", "z"] {
        if !columns.iter().any(|name| name == column) {
            db.execute(
                &format!("ALTER TABLE mining_rewards ADD COLUMN {column} INTEGER"),
                [],
            )?;
        }
    }
    if !columns.iter().any(|name| name == "player_name") {
        db.execute("ALTER TABLE mining_rewards ADD COLUMN player_name TEXT", [])?;
    }
    db.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS mining_rewards_xyz_idx ON mining_rewards (x,y,z)",
        [],
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
    let region = (p & !1, q & !1);
    let neighbor = (if p == region.0 { p - 2 } else { p + 1 }, region.1);
    for key in [region, neighbor] {
        if let Some(flow) = state.flows.get(&key) {
            flow.channel.snapshot(&flow.wet, p, q, &mut output);
        } else if let Some(channel) = flow::Channel::load(&state.db, key)? {
            channel.snapshot(&channel.reachable(), p, q, &mut output);
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

fn ore_miner(player: &Player) -> String {
    if let Some(address) = &player.reward_address {
        format!("wallet:{address}")
    } else if let Some(guest) = &player.guest_id {
        format!("guest:{guest}")
    } else {
        format!("name:{}", player.name)
    }
}

fn ore_progress(db: &Connection, server: &Server, player: &Player) -> rusqlite::Result<[i64; 3]> {
    let mut progress = [0; 3];
    for (index, ore) in TRACKED_ORES.into_iter().enumerate() {
        let count = match (server.reward_categories.get(&ore), &player.reward_address, &player.guest_id) {
            (Some(category), Some(address), _) => db.query_row(
                "SELECT blocks FROM mina_mining_progress WHERE cash_address=? AND category=?",
                params![address, category], |row| row.get(0),
            ),
            (Some(category), _, Some(guest)) => db.query_row(
                "SELECT blocks FROM guest_mining_progress WHERE guest_id=? AND category=?",
                params![guest, category], |row| row.get(0),
            ),
            _ => db.query_row(
                "SELECT blocks % 10 FROM ore_scores WHERE miner=? AND ore=?",
                params![ore_miner(player), ore], |row| row.get(0),
            ),
        };
        progress[index] = count.optional()?.unwrap_or(0);
    }
    Ok(progress)
}

fn send_ore_progress(player: &Player, [green, blue, red]: [i64; 3]) {
    send(player, format!("OP,{green},{blue},{red}\n"));
}

fn completed_mina_rewards(db: &Connection, player: &Player, category: &str) -> rusqlite::Result<i64> {
    if let Some(address) = player.reward_address.as_deref() {
        db.query_row(
            "SELECT COUNT(*) FROM mining_rewards WHERE cash_address=?1 AND category=?2",
            params![address, category], |row| row.get(0),
        )
    } else if let Some(guest) = player.guest_id.as_deref() {
        db.query_row(
            "SELECT COUNT(*) FROM guest_mining_rewards WHERE guest_id=?1 AND category=?2",
            params![guest, category], |row| row.get(0),
        )
    } else {
        Ok(0)
    }
}

fn block_edit(server: &Server, id: u32, x: i32, y: i32, z: i32, w: i32) -> rusqlite::Result<()> {
    if x.unsigned_abs() > MAX_COORD as u32
        || z.unsigned_abs() > MAX_COORD as u32
        || !(WORLD_MIN_Y + 1..=WORLD_MAX_Y).contains(&y)
    {
        if let Some(player) = server.state.lock().unwrap().players.get(&id) {
            let (p, q) = (chunked(x), chunked(z));
            send(
                player,
                format!("B,{p},{q},{x},{y},{z},0\nR,{p},{q}\nT,Invalid block edit.\n"),
            );
            if w > 0 {
                send(player, format!("J,{x},{y},{z},{w},0\n"));
            }
        }
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
    let channel_cell = y < 0 && flow::is_channel((x, y, z));
    let replace_liquid = channel_cell && matches!(previous, 12 | 13);
    let allowed =
        (0..=15).contains(&w) || (17..=23).contains(&w) || (32..=67).contains(&w)
            || w == MINA_ORE || w == LAPIS_LAZULI_ORE;
    let distance = ((player.position[0] - x as f64).powi(2)
        + (player.position[1] - y as f64).powi(2)
        + (player.position[2] - z as f64).powi(2))
    .sqrt();
    if !allowed
        || matches!(previous, 16 | BEDROCK)
        || (y < 0 && w == 0 && matches!(previous, 12 | 13))
        || (w == 0 && previous == 0)
        || (w != 0 && previous != 0 && !replace_liquid)
        || distance > 10.0
        || (w > 0 && w < 256 && player.inventory[w as usize] == 0)
    {
        send(
            &player,
            format!("B,{p},{q},{x},{y},{z},{previous}\nR,{p},{q}\nT,Invalid block edit.\n")
                .into_bytes(),
        );
        if w > 0 {
            send(&player, format!("J,{x},{y},{z},{w},0\n"));
        }
        return Ok(());
    }
    let region = flow::region(x, z);
    let old_flow = if channel_cell {
        Some(match state.flows.get(&region) {
            Some(flow) => flow.wet.clone(),
            None => flow::Channel::settled(&state.db, region)?,
        })
    } else {
        None
    };
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
    let mut reward_id = None;
    let mut guest_progress = None;
    let mut tracked_progress = None;
    if w == 0 {
        if previous == MINA_ORE {
            transaction.execute(
                "UPDATE mining_totals SET total=total+1 WHERE name='mina_ore'",
                [],
            )?;
        }
        transaction.execute(
            "DELETE FROM sign WHERE x=?1 AND y=?2 AND z=?3",
            params![x, y, z],
        )?;
        if edited.is_none() {
            if TRACKED_ORES.contains(&default) {
                transaction.execute(
                    "INSERT INTO ore_scores (miner,ore,player_name,blocks) VALUES (?1,?2,?3,1)
                     ON CONFLICT(miner,ore) DO UPDATE SET blocks=blocks+1,player_name=excluded.player_name",
                    params![ore_miner(&player), default, player.name],
                )?;
            }
            if let (Some(address), Some(category)) = (
                player.reward_address.as_ref(),
                server.reward_categories.get(&default),
            ) {
                let mut qualifies = true;
                if TRACKED_ORES.contains(&default) {
                    transaction.execute(
                        "INSERT INTO mina_mining_progress (cash_address,category,blocks) VALUES (?1,?2,0)
                         ON CONFLICT(cash_address,category) DO NOTHING",
                        params![address, category],
                    )?;
                    let blocks: i64 = transaction.query_row(
                        "SELECT blocks FROM mina_mining_progress WHERE cash_address=?1 AND category=?2",
                        params![address, category],
                        |row| row.get(0),
                    )?;
                    qualifies = blocks == 9;
                    transaction.execute(
                        "UPDATE mina_mining_progress SET blocks=?3 WHERE cash_address=?1 AND category=?2",
                        params![address, category, if qualifies { 0 } else { blocks + 1 }],
                    )?;
                    if let Some(guest) = player.guest_id.as_deref().filter(|_| default == MINA_ORE) {
                        transaction.execute(
                            "INSERT INTO guest_mining_progress (guest_id,category,blocks,unlocked) VALUES (?1,?2,0,?3)
                             ON CONFLICT(guest_id,category) DO UPDATE SET unlocked=MAX(unlocked,excluded.unlocked)",
                            params![guest, category, qualifies],
                        )?;
                        let unlocked: bool = transaction.query_row(
                            "SELECT unlocked FROM guest_mining_progress WHERE guest_id=?1 AND category=?2",
                            params![guest, category], |row| row.get(0),
                        )?;
                        guest_progress = Some((if qualifies { 0 } else { blocks + 1 }, unlocked));
                    }
                }
                if qualifies {
                    transaction.execute(
                        "INSERT INTO mining_rewards (x,y,z,cash_address,category,player_name) VALUES (?1,?2,?3,?4,?5,?6)",
                        params![x, y, z, address, category, player.name],
                    )?;
                    reward_id = Some(transaction.last_insert_rowid());
                }
            } else if TRACKED_ORES.contains(&default) && player.reward_address.is_none() {
                if let (Some(guest), Some(category)) = (
                    player.guest_id.as_ref(),
                    server.reward_categories.get(&default),
                ) {
                    transaction.execute(
                        "INSERT INTO guest_mining_progress (guest_id,category,blocks) VALUES (?1,?2,0)
                         ON CONFLICT(guest_id,category) DO NOTHING",
                        params![guest, category],
                    )?;
                    let (blocks, unlocked): (i64, bool) = transaction.query_row(
                        "SELECT blocks,unlocked FROM guest_mining_progress WHERE guest_id=?1 AND category=?2",
                        params![guest, category],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )?;
                    let qualifies = blocks == 9;
                    let blocks = if qualifies { 0 } else { blocks + 1 };
                    let unlocked = unlocked || qualifies;
                    transaction.execute(
                        "UPDATE guest_mining_progress SET blocks=?3,unlocked=?4,last_x=?5,last_y=?6,last_z=?7
                         WHERE guest_id=?1 AND category=?2",
                        params![guest, category, blocks, unlocked, x, y, z],
                    )?;
                    if qualifies {
                        transaction.execute(
                            "INSERT INTO guest_mining_rewards (guest_id,category,x,y,z,player_name) VALUES (?1,?2,?3,?4,?5,?6)",
                            params![guest, category, x, y, z, player.name],
                        )?;
                    }
                    if default == MINA_ORE {
                        guest_progress = Some((blocks, unlocked));
                    }
                }
            }
            if TRACKED_ORES.contains(&default) {
                tracked_progress = Some(ore_progress(&transaction, server, &player)?);
            }
        }
        transaction.execute(
            "UPDATE light SET w=0 WHERE x=?1 AND y=?2 AND z=?3",
            params![x, y, z],
        )?;
    }
    let pending_flow = if let Some(wet) = old_flow {
        flow::Channel::load(&transaction, region)?.map(|channel| flow::Flow::new(channel, wet))
    } else {
        None
    };
    transaction.commit()?;
    if let Some(flow) = pending_flow {
        state.flows.insert(region, flow);
    }
    if w == 0 {
        let inventory = &mut state.players.get_mut(&id).unwrap().inventory;
        if (1..256).contains(&previous) {
            inventory[previous as usize] = inventory[previous as usize].saturating_add(1);
        }
        send(&player, format!("I,{previous}\n"));
        if let Some(progress) = tracked_progress {
            send_ore_progress(&player, progress);
        }
        if let Some((blocks, unlocked)) = guest_progress {
            send(&player, format!("G,{blocks},{}\n", i32::from(unlocked)));
            if let Some(category) = server.reward_categories.get(&MINA_ORE) {
                let completed = completed_mina_rewards(&state.db, &player, category)?;
                send(&player, format!("ME,{completed}\n"));
            }
        }
        if reward_id.is_some() && default == MINA_ORE {
            if let Some(address) = player.reward_address.as_deref() {
                send(&player, format!("Q,{address}\n"));
            }
        }
    } else {
        state.players.get_mut(&id).unwrap().inventory[w as usize] -= 1;
        send(&player, format!("J,{x},{y},{z},{w},1\n"));
    }
    broadcast(&state, Some(id), &changes.concat());
    if let Some(reward_id) = reward_id {
        if server.reward_wake.as_ref().map_or(true, |sender| {
            sender.try_send((reward_id, player.clone())).is_err()
        }) {
            eprintln!("Could not dispatch mining reward {reward_id}; check the payout backend");
            if let Some(address) = player.reward_address.as_deref() {
                send(&player, format!("F,{address}\n"));
            }
        }
    }
    Ok(())
}

fn light_edit(server: &Server, id: u32, x: i32, y: i32, z: i32, w: i32) -> rusqlite::Result<()> {
    if x.unsigned_abs() > MAX_COORD as u32
        || z.unsigned_abs() > MAX_COORD as u32
        || !(WORLD_MIN_Y + 1..=WORLD_MAX_Y).contains(&y)
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
        || !(WORLD_MIN_Y + 1..=WORLD_MAX_Y).contains(&y)
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

fn sync_guest_rewards(server: &Server, id: u32) -> rusqlite::Result<()> {
    let mut state = server.state.lock().unwrap();
    let Some(player) = state.players.get(&id).cloned() else {
        return Ok(());
    };
    let Some(guest) = player.guest_id.as_deref() else {
        send_ore_progress(&player, ore_progress(&state.db, server, &player)?);
        return Ok(());
    };
    let mut rewards = Vec::new();
    let transaction = state.db.transaction()?;
    if let Some(address) = player.reward_address.as_deref() {
        let guest_miner = format!("guest:{guest}");
        transaction.execute(
            "INSERT INTO ore_scores (miner,ore,player_name,blocks)
             SELECT ?1,ore,?2,blocks FROM ore_scores WHERE miner=?3
             ON CONFLICT(miner,ore) DO UPDATE SET blocks=ore_scores.blocks+excluded.blocks,player_name=excluded.player_name",
            params![ore_miner(&player), player.name, guest_miner],
        )?;
        transaction.execute("DELETE FROM ore_scores WHERE miner=?", [&guest_miner])?;
        let pending = {
            let mut query = transaction.prepare(
                "SELECT category,x,y,z,player_name FROM guest_mining_rewards WHERE guest_id=?1",
            )?;
            let rows = query
                .query_map([guest], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, i32>(1)?,
                        r.get::<_, i32>(2)?,
                        r.get::<_, i32>(3)?,
                        r.get::<_, Option<String>>(4)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            rows
        };
        for (category, x, y, z, name) in pending {
            transaction.execute(
                "INSERT INTO mining_rewards (x,y,z,cash_address,category,player_name) VALUES (?1,?2,?3,?4,?5,?6)",
                params![x, y, z, address, category, name],
            )?;
            rewards.push(transaction.last_insert_rowid());
        }
        transaction.execute(
            "DELETE FROM guest_mining_rewards WHERE guest_id=?1",
            [guest],
        )?;
        let progress = {
            let mut query = transaction.prepare(
                "SELECT category,blocks,last_x,last_y,last_z FROM guest_mining_progress WHERE guest_id=?1 AND blocks>0"
            )?;
            let rows = query
                .query_map([guest], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, i64>(1)?,
                        r.get::<_, i32>(2)?,
                        r.get::<_, i32>(3)?,
                        r.get::<_, i32>(4)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            rows
        };
        for (category, blocks, x, y, z) in progress {
            transaction.execute(
                "INSERT INTO mina_mining_progress (cash_address,category,blocks) VALUES (?1,?2,0)
                 ON CONFLICT(cash_address,category) DO NOTHING",
                params![address, category],
            )?;
            let previous: i64 = transaction.query_row(
                "SELECT blocks FROM mina_mining_progress WHERE cash_address=?1 AND category=?2",
                params![address, category],
                |r| r.get(0),
            )?;
            let total = previous + blocks;
            transaction.execute(
                "UPDATE mina_mining_progress SET blocks=?3 WHERE cash_address=?1 AND category=?2",
                params![address, category, total % 10],
            )?;
            if total >= 10 {
                transaction.execute(
                    "INSERT INTO mining_rewards (x,y,z,cash_address,category,player_name) VALUES (?1,?2,?3,?4,?5,?6)",
                    params![x, y, z, address, category, player.name],
                )?;
                rewards.push(transaction.last_insert_rowid());
            }
            transaction.execute(
                "UPDATE guest_mining_progress SET blocks=0,unlocked=CASE WHEN ?3 THEN 1 ELSE unlocked END
                 WHERE guest_id=?1 AND category=?2",
                params![guest, category, total >= 10],
            )?;
        }
    }
    let progress =
        if let Some(category) = server.reward_categories.get(&MINA_ORE) {
            let guest_progress = transaction.query_row(
            "SELECT blocks,unlocked FROM guest_mining_progress WHERE guest_id=?1 AND category=?2",
            params![guest, category], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, bool>(1)?)),
        ).optional()?.unwrap_or((0, false));
            if let Some(address) = player.reward_address.as_deref() {
                let blocks = transaction.query_row(
                "SELECT blocks FROM mina_mining_progress WHERE cash_address=?1 AND category=?2",
                params![address, category], |r| r.get::<_, i64>(0),
            ).optional()?.unwrap_or(0);
                (blocks, guest_progress.1)
            } else {
                guest_progress
            }
        } else {
            (0, false)
        };
    let completed = if let Some(category) = server.reward_categories.get(&MINA_ORE) {
        completed_mina_rewards(&transaction, &player, category)?
    } else {
        0
    };
    let ore_counts = ore_progress(&transaction, server, &player)?;
    transaction.commit()?;
    drop(state);
    send(
        &player,
        format!("G,{},{}\n", progress.0, i32::from(progress.1)),
    );
    send(&player, format!("ME,{completed}\n"));
    send_ore_progress(&player, ore_counts);
    if let Some(address) = player.reward_address.as_deref() {
        for reward in rewards {
            send(&player, format!("Q,{address}\n"));
            if server.reward_wake.as_ref().map_or(true, |sender| {
                sender.try_send((reward, player.clone())).is_err()
            }) {
                eprintln!("Could not dispatch mining reward {reward}; check the payout backend");
                send(&player, format!("F,{address}\n"));
            }
        }
    }
    Ok(())
}

fn handle_command(server: &Server, id: u32, line: &str) -> rusqlite::Result<bool> {
    let mut parts = line.split(',');
    let command = parts.next().unwrap_or("");
    let args: Vec<&str> = parts.collect();
    match command {
        "ZA" if args.len() == 1 => {
            if let Ok(animal_id) = args[0].parse() {
                hit_animal(server, id, animal_id, world_time(), Instant::now())?;
            }
        }
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
                    if player.position.as_slice() != values.as_slice() {
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
        "G" if args.len() == 1
            && args[0].len() == 64
            && args[0]
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)) =>
        {
            {
                let mut state = server.state.lock().unwrap();
                if let Some(player) = state.players.get_mut(&id) {
                    if player
                        .guest_id
                        .as_deref()
                        .map_or(true, |saved| saved == args[0])
                    {
                        player.guest_id = Some(args[0].to_owned());
                    } else {
                        return Ok(false);
                    }
                }
            }
            sync_guest_rewards(server, id)?;
        }
        "W" if args.len() == 1 => {
            let address = args[0].to_ascii_lowercase();
            if address.is_empty() {
                let mut state = server.state.lock().unwrap();
                if let Some(player) = state.players.get_mut(&id) {
                    if player.reward_address.take().is_some() {
                        send(player, b"T,Mining reward address disconnected.\n".to_vec());
                    }
                }
                drop(state);
                sync_guest_rewards(server, id)?;
            } else if valid_reward_address(&address, &server.address_prefix) && args[0] == address {
                let mut state = server.state.lock().unwrap();
                if let Some(player) = state.players.get_mut(&id) {
                    if player.reward_address.as_ref() != Some(&address) {
                        player.reward_address = Some(address);
                        send(player, b"T,Mining reward address connected.\n".to_vec());
                    }
                }
                drop(state);
                sync_guest_rewards(server, id)?;
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
            guest_id: None,
            inventory: [0; 256],
            lives: PLAYER_LIVES,
            last_attack_tick: None,
            last_pickaxe: None,
        };
        let now = world_time();
        send(
            &player,
            format!("U,{id},0,0,0,0,0\nE,{now},{DAY_LENGTH}\nZN,{}\nHP,{PLAYER_LIVES}\nT,Welcome to NetCraft!\n", u8::from(is_night(now))).into_bytes(),
        );
        let mut snapshot = String::new();
        for (other_id, other) in &state.players {
            let [x, y, z, rx, ry] = other.position;
            snapshot.push_str(&format!(
                "P,{other_id},{x},{y},{z},{rx},{ry}\nN,{other_id},{}\n",
                other.name
            ));
        }
        for animal in &state.animals {
            snapshot.push_str(&animal.message());
        }
        if !snapshot.is_empty() {
            send(&player, snapshot.into_bytes());
        }
        broadcast(
            &state,
            None,
            &format!(
                "P,{id},0,0,0,0,0\nN,{id},{}\nT,{} joined the game.\n",
                player.name, player.name
            ),
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

fn optional_category(name: &str) -> Result<Option<String>, String> {
    let value = env::var(name).ok().filter(|s| !s.is_empty());
    if value
        .as_ref()
        .is_some_and(|s| !(s.len() == 64 && s.bytes().all(|c| c.is_ascii_hexdigit())))
    {
        return Err(format!("{name} must be 64 hexadecimal characters"));
    }
    Ok(value.map(|s| s.to_ascii_lowercase()))
}

// Each ore reward is optional; an ore without a configured category grants nothing.
fn reward_configuration() -> Result<HashMap<i32, String>, String> {
    let mut categories = HashMap::new();
    let ores = [
        (MINA_ORE, "BCH_REWARD_CATEGORY"),
        (REDSTONE_ORE, "BCH_REDSTONE_REWARD_CATEGORY"),
        (GOLD_ORE, "BCH_GOLD_REWARD_CATEGORY"),
        (LAPIS_LAZULI_ORE, "BCH_LAPIS_REWARD_CATEGORY"),
    ];
    for (ore, name) in ores {
        if let Some(category) = optional_category(name)? {
            if categories.values().any(|existing| existing == &category) {
                return Err(format!("{name} must use a distinct token category"));
            }
            categories.insert(ore, category);
        }
    }
    Ok(categories)
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let address = env::var("NETCRAFT_LISTEN").unwrap_or_else(|_| "0.0.0.0:4080".into());
    let database = env::var("NETCRAFT_DB").unwrap_or_else(|_| "craft.db".into());
    let mut reward_categories = reward_configuration()?;
    match env::var("NETCRAFT_MINING_REWARDS_ENABLED").as_deref() {
        Ok("true") => {
            eprintln!("Warning: mining rewards are enabled without player authentication")
        }
        Ok("false") | Err(env::VarError::NotPresent) => {
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
            animals: Vec::new(),
            mempool: BTreeSet::new(),
            next_animal_id: 1,
            animal_tick: 0,
            animal_cursor: 0,
            night: None,
            flows: HashMap::new(),
        }),
        terrain: Mutex::new(Terrain::default()),
        reward_categories,
        address_prefix,
        reward_wake: start_reward_wake()?,
    });
    if let (Ok(target), Ok(secret)) = (
        env::var("NETCRAFT_REWARD_API"),
        env::var("NETCRAFT_REWARD_WAKE_SECRET"),
    ) {
        if !target.is_empty() {
            let server = server.clone();
            thread::spawn(move || loop {
                match poll_mempool(&target, &secret) {
                    Ok(txids) => server.state.lock().unwrap().mempool = txids,
                    Err(error) => eprintln!("NetCraft mempool poll failed: {error}"),
                }
                thread::sleep(MEMPOOL_POLL);
            });
        }
    }
    {
        let server = server.clone();
        thread::spawn(move || loop {
            thread::sleep(Duration::from_millis(200));
            advance_flows(&mut server.state.lock().unwrap());
        });
    }
    {
        let server = server.clone();
        thread::spawn(move || loop {
            thread::sleep(ANIMAL_TICK);
            if let Err(error) = update_animals(&server) {
                eprintln!("animal simulation failed: {error}");
            }
        });
    }
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
                animals: Vec::new(),
                mempool: BTreeSet::new(),
                next_animal_id: 1,
                animal_tick: 0,
                animal_cursor: 0,
                night: Some(false),
                flows: HashMap::new(),
            }),
            terrain: Mutex::new(Terrain::default()),
            reward_categories: HashMap::from([(MINA_ORE, "b".repeat(64))]),
            address_prefix: "bitcoincash".into(),
            reward_wake: None,
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
                    guest_id: None,
                    inventory: [0; 256],
                    lives: PLAYER_LIVES,
                    last_attack_tick: None,
                    last_pickaxe: None,
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
    fn upgrades_backend_created_reward_table_without_losing_pending_payouts() {
        let path = env::temp_dir().join(format!(
            "netcraft-reward-migration-{}-{}.sqlite3",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        {
            let db = Connection::open(&path).unwrap();
            db.execute_batch(
                "CREATE TABLE mining_rewards (
                    id INTEGER PRIMARY KEY, cash_address TEXT, category TEXT,
                    signed_tx TEXT, txid TEXT, sent_at TEXT
                 );
                 INSERT INTO mining_rewards (cash_address, category, signed_tx, txid)
                 VALUES ('old', 'category', 'signed', 'txid');",
            )
            .unwrap();
        }
        {
            let db = open_database(path.to_str().unwrap()).unwrap();
            let old: (String, String, String, String) = db
                .query_row(
                    "SELECT cash_address, category, signed_tx, txid FROM mining_rewards WHERE id=1",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
                )
                .unwrap();
            assert_eq!(
                old,
                (
                    "old".into(),
                    "category".into(),
                    "signed".into(),
                    "txid".into()
                )
            );
            db.execute(
                "INSERT INTO mining_rewards (x,y,z,cash_address,category) VALUES (1,2,3,'new','category')",
                [],
            ).unwrap();
            assert!(db.execute(
                "INSERT INTO mining_rewards (x,y,z,cash_address,category) VALUES (1,2,3,'other','category')",
                [],
            ).is_err());
        }
        std::fs::remove_file(path).unwrap();
    }

    fn ore_positions(server: &Server) -> Vec<(i32, i32, i32)> {
        let chunk = server.terrain.lock().unwrap().chunk(0, 0);
        let mut positions: Vec<_> = chunk
            .iter()
            .filter_map(|(&(x, y, z), &w)| {
                (w == MINA_ORE && (0..32).contains(&x) && (0..32).contains(&z)).then_some((x, y, z))
            })
            .collect();
        positions.sort_unstable();
        positions
    }

    fn move_to(server: &Server, (x, y, z): (i32, i32, i32)) {
        server
            .state
            .lock()
            .unwrap()
            .players
            .get_mut(&1)
            .unwrap()
            .position = [x as f64, y as f64, z as f64, 0.0, 0.0];
    }

    #[test]
    fn mined_ore_total_counts_successful_mines_even_without_rewards() {
        let (server, _, _) = setup();
        let (x, y, z) = ore_positions(&server)[0];
        move_to(&server, (x, y, z));
        block_edit(&server, 1, x, y, z, 0).unwrap();
        block_edit(&server, 1, x, y, z, 0).unwrap();
        block_edit(&server, 1, x, y, z, MINA_ORE).unwrap();
        block_edit(&server, 1, x, y, z, 0).unwrap();
        let state = server.state.lock().unwrap();
        let total: i64 = state.db.query_row(
            "SELECT total FROM mining_totals WHERE name='mina_ore'", [], |row| row.get(0),
        ).unwrap();
        assert_eq!(total, 2);
        assert_eq!(state.db.query_row("SELECT SUM(blocks) FROM ore_scores", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
    }

    #[test]
    fn deep_ores_are_rare_and_earn_separate_batches() {
        let (mut server, first, _) = setup();
        let (wake, wakes) = mpsc::sync_channel(4);
        server.reward_wake = Some(wake);
        let blue_category = "c".repeat(64);
        let red_category = "d".repeat(64);
        server.reward_categories.insert(LAPIS_LAZULI_ORE, blue_category.clone());
        server.reward_categories.insert(REDSTONE_ORE, red_category.clone());
        let (mut blue, mut red) = (Vec::new(), Vec::new());
        for p in -2..=2 {
            for q in -1..=1 {
                let chunk = server.terrain.lock().unwrap().chunk(p, q);
                for (&(x, y, z), &ore) in chunk.iter() {
                    if ore == LAPIS_LAZULI_ORE || ore == REDSTONE_ORE {
                        assert!(y > WORLD_MIN_Y && y < 16 && y != 0);
                        if ore == LAPIS_LAZULI_ORE {
                            blue.push((x, y, z));
                        } else {
                            red.push((x, y, z));
                        }
                    }
                }
            }
        }
        assert!(blue.len() > red.len() && red.len() >= 11, "blue: {}, red: {}", blue.len(), red.len());
        blue.sort_unstable();
        red.sort_unstable();
        let guest = "a".repeat(64);
        let address = "bitcoincash:zqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqweyg7usz";
        handle_command(&server, 1, &format!("G,{guest}")).unwrap();
        for (positions, count) in [(&blue, 9), (&red, 11)] {
            for &(x, y, z) in &positions[..count] {
                move_to(&server, (x, y, z));
                block_edit(&server, 1, x, y, z, 0).unwrap();
            }
        }
        assert!(wakes.try_recv().is_err());
        assert!(String::from_utf8(first.try_iter().flatten().collect()).unwrap().contains("OP,0,9,1\n"));
        handle_command(&server, 1, &format!("W,{address}")).unwrap();
        let (x, y, z) = blue[9];
        move_to(&server, (x, y, z));
        block_edit(&server, 1, x, y, z, 0).unwrap();
        handle_command(&server, 1, &format!("W,{address}")).unwrap();
        assert_eq!(wakes.try_iter().count(), 2);
        let state = server.state.lock().unwrap();
        for (category, ore, score) in [(blue_category, LAPIS_LAZULI_ORE, 10), (red_category, REDSTONE_ORE, 11)] {
            assert_eq!(state.db.query_row(
                "SELECT count(*) FROM mining_rewards WHERE category=? AND cash_address=?",
                params![category, address], |r| r.get::<_, i64>(0),
            ).unwrap(), 1);
            assert_eq!(state.db.query_row(
                "SELECT blocks FROM ore_scores WHERE miner=? AND ore=?",
                params![format!("wallet:{address}"), ore], |r| r.get::<_, i64>(0),
            ).unwrap(), score);
        }
        assert_eq!(state.db.query_row(
            "SELECT count(*) FROM ore_scores WHERE miner LIKE 'guest:%'", [], |r| r.get::<_, i64>(0),
        ).unwrap(), 0);
    }

    #[test]
    fn valley_lake_has_a_deep_floor_and_matches_across_chunk_edges() {
        let mut terrain = Terrain::default();
        let center = terrain.chunk(2, 0);
        let west = terrain.chunk(1, 0);
        let waters: Vec<i32> = (32..=200).filter(|y| center.get(&(80, *y, 0)) == Some(&12)).collect();
        assert!(waters.len() >= 6);
        let bottom = waters[0];
        let top = *waters.last().unwrap();
        assert_eq!(center.get(&(80, bottom - 1, 0)), Some(&2));
        assert!(!center.contains_key(&(80, top + 1, 0)));
        assert_eq!(center.get(&(64, top, 0)), Some(&12));
        assert_eq!(west.get(&(64, top, 0)), Some(&-12));
        let bank = terrain.chunk(3, 0);
        assert!((top + 1..=200).any(|y| bank.get(&(104, y, 0)).is_some()));
    }

    #[test]
    fn rewards_require_a_connected_player_with_a_wallet() {
        let (server, _, _) = setup();
        block_edit(&server, 1, 0, 1, 0, 0).unwrap();
        {
            let mut state = server.state.lock().unwrap();
            let rewards: i64 = state
                .db
                .query_row("SELECT count(*) FROM mining_rewards", [], |r| r.get(0))
                .unwrap();
            assert_eq!(rewards, 0);
            state.players.remove(&1);
        }
        block_edit(&server, 1, 1, 1, 0, 0).unwrap();
        let state = server.state.lock().unwrap();
        let rewards: i64 = state
            .db
            .query_row("SELECT count(*) FROM mining_rewards", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rewards, 0);
        let edits: i64 = state
            .db
            .query_row(
                "SELECT count(*) FROM block WHERE x=1 AND y=1 AND z=0",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(edits, 0);
    }

    #[test]
    fn guest_mining_claims_reward_once_after_connecting() {
        let (mut server, first, _second) = setup();
        let (wake, wakes) = mpsc::sync_channel(4);
        server.reward_wake = Some(wake);
        let guest = "a".repeat(64);
        let address = "bitcoincash:zqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqweyg7usz";
        handle_command(&server, 1, &format!("G,{guest}")).unwrap();
        let ores = ore_positions(&server);
        for &(x, y, z) in &ores[..10] {
            move_to(&server, (x, y, z));
            block_edit(&server, 1, x, y, z, 0).unwrap();
        }

        let messages = String::from_utf8(first.try_iter().flatten().collect()).unwrap();
        assert!(messages.contains("G,9,0\n"));
        assert!(messages.contains("G,0,1\n"));
        assert!(wakes.try_recv().is_err());
        {
            let state = server.state.lock().unwrap();
            assert_eq!(
                state
                    .db
                    .query_row("SELECT count(*) FROM guest_mining_rewards", [], |r| r
                        .get::<_, i64>(0))
                    .unwrap(),
                1
            );
            assert_eq!(
                state
                    .db
                    .query_row("SELECT count(*) FROM mining_rewards", [], |r| r
                        .get::<_, i64>(0))
                    .unwrap(),
                0
            );
        }
        handle_command(&server, 1, &format!("W,{address}")).unwrap();
        assert!(wakes.try_recv().is_ok());
        handle_command(&server, 1, &format!("W,{address}")).unwrap();
        assert!(wakes.try_recv().is_err());
        let state = server.state.lock().unwrap();
        assert_eq!(
            state
                .db
                .query_row("SELECT count(*) FROM guest_mining_rewards", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            state
                .db
                .query_row(
                    "SELECT count(*) FROM mining_rewards WHERE cash_address=?1",
                    [address],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
        drop(state);
        handle_command(&server, 2, &format!("G,{guest}")).unwrap();
        assert!(String::from_utf8(_second.try_iter().flatten().collect())
            .unwrap()
            .contains("G,0,1\n"));
    }

    #[test]
    fn completed_rewards_are_reported_to_guest_and_registered_wallet() {
        let (server, first, _) = setup();
        let guest = "a".repeat(64);
        let address = "bitcoincash:zqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqweyg7usz";
        handle_command(&server, 1, &format!("G,{guest}")).unwrap();
        let ores = ore_positions(&server);
        assert!(ores.len() >= 20);
        let mut messages = String::new();
        for &(x, y, z) in &ores[..20] {
            move_to(&server, (x, y, z));
            block_edit(&server, 1, x, y, z, 0).unwrap();
            messages.push_str(&String::from_utf8(first.try_iter().flatten().collect()).unwrap());
        }
        assert!(messages.contains("ME,2\n"));
        handle_command(&server, 1, &format!("W,{address}")).unwrap();
        let messages = String::from_utf8(first.try_iter().flatten().collect()).unwrap();
        assert!(messages.contains("ME,2\n"));
    }

    #[test]
    fn guest_identity_is_validated_and_cannot_change_mid_connection() {
        let (server, _first, _second) = setup();
        handle_command(&server, 1, "G,invalid").unwrap();
        assert!(server.state.lock().unwrap().players[&1].guest_id.is_none());
        let guest = "a".repeat(64);
        assert!(handle_command(&server, 1, &format!("G,{guest}")).unwrap());
        assert!(!handle_command(&server, 1, &format!("G,{}", "b".repeat(64))).unwrap());
        assert_eq!(server.state.lock().unwrap().players[&1].guest_id.as_deref(), Some(guest.as_str()));
    }

    #[test]
    fn guest_partial_progress_merges_with_wallet_progress_once() {
        let (server, _first, _second) = setup();
        let guest = "b".repeat(64);
        let address = "bitcoincash:zqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqweyg7usz";
        handle_command(&server, 1, &format!("W,{address}")).unwrap();
        let ores = ore_positions(&server);
        for &(x, y, z) in &ores[..7] {
            move_to(&server, (x, y, z));
            block_edit(&server, 1, x, y, z, 0).unwrap();
        }
        handle_command(&server, 1, "W,").unwrap();
        handle_command(&server, 1, &format!("G,{guest}")).unwrap();
        for &(x, y, z) in &ores[7..11] {
            move_to(&server, (x, y, z));
            block_edit(&server, 1, x, y, z, 0).unwrap();
        }
        handle_command(&server, 1, &format!("W,{address}")).unwrap();
        handle_command(&server, 1, &format!("W,{address}")).unwrap();
        let state = server.state.lock().unwrap();
        assert_eq!(
            state
                .db
                .query_row(
                    "SELECT blocks FROM mina_mining_progress WHERE cash_address=?1",
                    [address],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
        assert_eq!(
            state
                .db
                .query_row("SELECT count(*) FROM mining_rewards", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            state
                .db
                .query_row(
                    "SELECT unlocked FROM guest_mining_progress WHERE guest_id=?1",
                    [guest],
                    |r| r.get::<_, bool>(0)
                )
                .unwrap(),
            true
        );
    }

    #[test]
    fn guest_progress_survives_database_reopen_and_reconnect() {
        let path = env::temp_dir().join(format!(
            "netcraft-guest-progress-{}-{}.sqlite3",
            std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        ));
        let (server, _first, _second) = setup();
        server.state.lock().unwrap().db = open_database(path.to_str().unwrap()).unwrap();
        let guest = "c".repeat(64);
        handle_command(&server, 1, &format!("G,{guest}")).unwrap();
        let ores = ore_positions(&server);
        for &(x, y, z) in &ores[..9] {
            move_to(&server, (x, y, z));
            block_edit(&server, 1, x, y, z, 0).unwrap();
        }
        server.state.lock().unwrap().db = open_database(path.to_str().unwrap()).unwrap();
        handle_command(&server, 2, &format!("G,{guest}")).unwrap();
        let (x, y, z) = ores[9];
        server.state.lock().unwrap().players.get_mut(&2).unwrap().position =
            [x as f64, y as f64, z as f64, 0.0, 0.0];
        block_edit(&server, 2, x, y, z, 0).unwrap();
        let state = server.state.lock().unwrap();
        assert_eq!(
            state.db.query_row(
                "SELECT blocks,unlocked FROM guest_mining_progress WHERE guest_id=?1",
                [guest], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, bool>(1)?))
            ).unwrap(),
            (0, true)
        );
        assert_eq!(state.db.query_row("SELECT count(*) FROM guest_mining_rewards", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
        drop(state);
        drop(server);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn wallet_can_be_disconnected_and_reconnected_without_leaving_game() {
        let (server, _, _) = setup();
        let ores = ore_positions(&server);
        assert!(ores.len() >= 2);
        let address = "bitcoincash:zqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqweyg7usz";
        handle_command(&server, 1, &format!("W,{address}")).unwrap();
        handle_command(&server, 1, "W,").unwrap();
        let (x, y, z) = ores[0];
        move_to(&server, ores[0]);
        block_edit(&server, 1, x, y, z, 0).unwrap();
        handle_command(&server, 1, &format!("W,{address}")).unwrap();
        let (x, y, z) = ores[1];
        move_to(&server, ores[1]);
        block_edit(&server, 1, x, y, z, 0).unwrap();
        let state = server.state.lock().unwrap();
        let count: i64 = state
            .db
            .query_row("SELECT count(*) FROM mining_rewards", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
        let progress: i64 = state
            .db
            .query_row(
                "SELECT blocks FROM mina_mining_progress WHERE cash_address=?1",
                [address],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(progress, 1);
        assert!(state.players.contains_key(&1));
    }

    #[test]
    fn natural_block_reward_is_atomic_and_once_only() {
        let (mut server, _first, second) = setup();
        let (wake, wakes) = mpsc::sync_channel(2);
        server.reward_wake = Some(wake);
        let address = "bitcoincash:zqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqweyg7usz";
        handle_command(&server, 1, &format!("W,{address}")).unwrap();
        block_edit(&server, 1, 0, 1, 0, 0).unwrap();
        assert!(wakes.try_recv().is_err());
        second.try_recv().unwrap();
        let ores = ore_positions(&server);
        assert!(
            ores.len() >= 8 && ores.len() < 128,
            "unexpected ore density: {}",
            ores.len()
        );
        for &(x, y, z) in &ores[..9] {
            move_to(&server, (x, y, z));
            block_edit(&server, 1, x, y, z, 0).unwrap();
            assert!(wakes.try_recv().is_err());
        }
        handle_command(&server, 1, "W,").unwrap();
        handle_command(&server, 1, &format!("W,{address}")).unwrap();
        let (x, y, z) = ores[9];
        move_to(&server, ores[9]);
        block_edit(&server, 1, x, y, z, 0).unwrap();
        let player_messages = _first.try_iter().flatten().collect::<Vec<_>>();
        let player_messages = String::from_utf8(player_messages).unwrap();
        assert!(player_messages.contains(&format!("Q,{address}\n")));
        assert!(wakes.try_recv().is_ok());
        let update = String::from_utf8(second.try_recv().unwrap()).unwrap();
        assert!(update.contains("B,0,0,"));
        block_edit(&server, 1, x, y, z, MINA_ORE).unwrap();
        block_edit(&server, 1, x, y, z, 0).unwrap();
        assert!(wakes.try_recv().is_err());
        let state = server.state.lock().unwrap();
        let (count, category, recipient, name): (i64, String, String, String) = state
            .db
            .query_row(
                "SELECT count(*),category,cash_address,player_name FROM mining_rewards",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!(count, 1);
        assert_eq!(category, "b".repeat(64));
        assert_eq!(recipient, address);
        assert_eq!(name, "guest1");
        drop(state);
        chunk_response(&server, 1, 0, 0, -1).unwrap();
        let output = _first.try_iter().last().unwrap();
        let output = String::from_utf8(output).unwrap();
        assert!(output.contains(&format!("B,0,0,{x},{y},{z},0\n")));
        assert!(output.contains("R,0,0\nC,0,0\n"));
        assert_eq!(chunked(-1), -1);
    }

    #[test]
    fn browser_wallet_can_queue_multiple_ore_rewards() {
        let (server, _, _) = setup();
        let address = "bitcoincash:zqyx49mu0kkn9ftfj6hje6g2wfer34yfnqnpwfwhlf";
        handle_command(&server, 1, &format!("W,{address}")).unwrap();
        let ores = ore_positions(&server);
        assert!(ores.len() >= 20);
        for (index, &(x, y, z)) in ores[..20].iter().enumerate() {
            move_to(&server, (x, y, z));
            block_edit(&server, 1, x, y, z, 0).unwrap();
            let count: i64 = server
                .state
                .lock()
                .unwrap()
                .db
                .query_row(
                    "SELECT count(*) FROM mining_rewards WHERE cash_address = ?1",
                    [address],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(count, ((index + 1) / 10) as i64);
        }
        let state = server.state.lock().unwrap();
        let count: i64 = state
            .db
            .query_row(
                "SELECT count(*) FROM mining_rewards WHERE cash_address = ?1",
                [address],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 2);
    }

    #[test]
    fn mina_progress_is_isolated_by_address_and_survives_database_reopen() {
        let path = env::temp_dir().join(format!(
            "netcraft-mina-progress-{}-{}.sqlite3",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let (server, _, _) = setup();
        server.state.lock().unwrap().db = open_database(path.to_str().unwrap()).unwrap();
        let a = "bitcoincash:zqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqweyg7usz";
        let b = "bitcoincash:zqyx49mu0kkn9ftfj6hje6g2wfer34yfnqnpwfwhlf";
        let ores = ore_positions(&server);
        assert!(ores.len() >= 11);
        handle_command(&server, 1, &format!("W,{a}")).unwrap();
        for &(x, y, z) in &ores[..9] {
            move_to(&server, (x, y, z));
            block_edit(&server, 1, x, y, z, 0).unwrap();
        }
        handle_command(&server, 1, &format!("W,{b}")).unwrap();
        let (x, y, z) = ores[9];
        move_to(&server, ores[9]);
        block_edit(&server, 1, x, y, z, 0).unwrap();
        server.state.lock().unwrap().db = open_database(path.to_str().unwrap()).unwrap();
        handle_command(&server, 1, &format!("W,{a}")).unwrap();
        let (x, y, z) = ores[10];
        move_to(&server, ores[10]);
        block_edit(&server, 1, x, y, z, 0).unwrap();
        let state = server.state.lock().unwrap();
        let rewards: i64 = state
            .db
            .query_row(
                "SELECT count(*) FROM mining_rewards WHERE cash_address=?1",
                [a],
                |r| r.get(0),
            )
            .unwrap();
        let progress: i64 = state
            .db
            .query_row(
                "SELECT blocks FROM mina_mining_progress WHERE cash_address=?1",
                [b],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(rewards, 1);
        assert_eq!(progress, 1);
        drop(state);
        drop(server);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn extended_block_types_can_be_placed() {
        let (server, _first, second) = setup();
        {
            let mut state = server.state.lock().unwrap();
            let player = state.players.get_mut(&1).unwrap();
            player.position[1] = 100.0;
            player.inventory[67] = 1;
        }
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
        handle_command(&server, 1, "P,0,100,0,0,0").unwrap();
        assert!(second.try_recv().is_err());
        server
            .state
            .lock()
            .unwrap()
            .players
            .get_mut(&1)
            .unwrap()
            .inventory[6] = 1;
        block_edit(&server, 1, 0, 100, 0, 6).unwrap();
        assert_eq!(
            String::from_utf8(first.try_recv().unwrap()).unwrap(),
            "J,0,100,0,6,1\n"
        );
        let placed = String::from_utf8(second.try_recv().unwrap()).unwrap();
        assert!(placed.contains("B,0,0,0,100,0,6\nR,0,0\n"));
        block_edit(&server, 1, 0, 100, 0, 0).unwrap();
        let mined = String::from_utf8(second.try_recv().unwrap()).unwrap();
        assert!(mined.contains("B,0,0,0,100,0,0\nR,0,0\n"));
        assert_eq!(
            String::from_utf8(first.try_recv().unwrap()).unwrap(),
            "I,6\n"
        );
        assert!(first.try_recv().is_err());
    }

    #[test]
    fn building_requires_matching_inventory_and_does_not_spend_on_rejection() {
        let (server, first, _) = setup();
        block_edit(&server, 1, 0, 1, 0, 0).unwrap();
        assert_eq!(
            String::from_utf8(first.try_recv().unwrap()).unwrap(),
            "I,6\n"
        );
        block_edit(&server, 1, 0, 1, 0, 7).unwrap();
        let rejected = String::from_utf8(first.try_recv().unwrap()).unwrap();
        assert!(rejected.contains("Invalid block edit"));
        assert_eq!(
            String::from_utf8(first.try_recv().unwrap()).unwrap(),
            "J,0,1,0,7,0\n"
        );
        assert_eq!(server.state.lock().unwrap().players[&1].inventory[6], 1);
        block_edit(&server, 1, 0, 1, 0, 6).unwrap();
        assert_eq!(
            String::from_utf8(first.try_recv().unwrap()).unwrap(),
            "J,0,1,0,6,1\n"
        );
        assert_eq!(server.state.lock().unwrap().players[&1].inventory[6], 0);
    }

    #[test]
    fn out_of_bounds_placement_is_rejected_without_spending() {
        let (server, first, _) = setup();
        server
            .state
            .lock()
            .unwrap()
            .players
            .get_mut(&1)
            .unwrap()
            .inventory[6] = 1;
        block_edit(&server, 1, 0, 256, 0, 6).unwrap();
        let correction = String::from_utf8(first.try_recv().unwrap()).unwrap();
        assert!(correction.contains("B,0,0,0,256,0,0\n"));
        assert_eq!(
            String::from_utf8(first.try_recv().unwrap()).unwrap(),
            "J,0,256,0,6,0\n"
        );
        assert_eq!(server.state.lock().unwrap().players[&1].inventory[6], 1);
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

    #[test]
    fn animals_move_and_despawn_for_all_players() {
        let (server, first, second) = setup();
        {
            let mut state = server.state.lock().unwrap();
            for player in state.players.values_mut() {
                player.position = [0.0, 200.5, 0.0, 0.0, 0.0];
            }
            for z in [0, -1] {
                state
                    .db
                    .execute(
                        "INSERT INTO block (p,q,x,y,z,w) VALUES (?1,?2,0,200,?3,6)",
                        params![0, chunked(z), z],
                    )
                    .unwrap();
            }
            let txid = "012345".to_owned() + &"0".repeat(52) + "abcdef";
            state.mempool.insert(txid.clone());
            state.animals.push(Animal {
                id: 7,
                txid,
                x: 0.0,
                y: 200.5,
                z: 0.0,
                heading: 0,
                pacified: false,
            });
        }
        update_animals_at(&server, 300).unwrap();
        let one = String::from_utf8(first.try_recv().unwrap()).unwrap();
        let two = String::from_utf8(second.try_recv().unwrap()).unwrap();
        assert_eq!(one, two);
        assert!(one.contains("M,7,0.00,200.50,-0.60,0,012345...abcdef,0\n"));
        {
            let mut state = server.state.lock().unwrap();
            for player in state.players.values_mut() {
                player.position[0] = 1000.0;
            }
            state.mempool.clear();
        }
        update_animals_at(&server, 300).unwrap();
        assert_eq!(first.try_recv().unwrap(), b"MD,7\n");
        assert_eq!(second.try_recv().unwrap(), b"MD,7\n");
    }

    #[test]
    fn animals_do_not_walk_through_built_blocks() {
        let (server, _, _) = setup();
        let mut terrain = server.terrain.lock().unwrap();
        let state = server.state.lock().unwrap();
        state
            .db
            .execute("INSERT INTO block (p,q,x,y,z,w) VALUES (0,0,0,200,0,6)", [])
            .unwrap();
        assert_eq!(
            animal_ground(&mut terrain, &state.db, 0, 0).unwrap(),
            Some(200)
        );
        state
            .db
            .execute("INSERT INTO block (p,q,x,y,z,w) VALUES (0,0,0,201,0,8)", [])
            .unwrap();
        assert_eq!(animal_ground(&mut terrain, &state.db, 0, 0).unwrap(), None);
    }

    #[test]
    fn animals_spawn_near_players_and_are_shared() {
        let (server, first, second) = setup();
        {
            let mut state = server.state.lock().unwrap();
            state.mempool.insert("a".repeat(64));
            for player in state.players.values_mut() {
                player.position = [0.0, 200.5, 0.0, 0.0, 0.0];
            }
            state
                .db
                .execute(
                    "INSERT INTO block (p,q,x,y,z,w) VALUES (-1,-1,-8,179,-8,6)",
                    [],
                )
                .unwrap();
        }
        update_animals_at(&server, 300).unwrap();
        let one = String::from_utf8(first.try_recv().unwrap()).unwrap();
        let two = String::from_utf8(second.try_recv().unwrap()).unwrap();
        assert_eq!(one, two);
        assert_eq!(one, "M,1,-8.00,179.50,-8.00,1,aaaaaa...aaaaaa,0\n");
    }

    #[test]
    fn animals_do_not_spawn_on_the_central_sky_park() {
        let (server, _, _) = setup();
        {
            let mut state = server.state.lock().unwrap();
            state.mempool.insert("a".repeat(64));
            for player in state.players.values_mut() {
                player.position = [0.0, 182.0, 0.0, 0.0, 0.0];
            }
            state.db.execute(
                "INSERT INTO block (p,q,x,y,z,w) VALUES (-1,-1,-8,180,-8,6)", [],
            ).unwrap();
        }
        update_animals_at(&server, 300).unwrap();
        assert!(server.state.lock().unwrap().animals.is_empty());
        {
            let mut state = server.state.lock().unwrap();
            for player in state.players.values_mut() {
                player.position[0] = 37.0;
            }
            state.db.execute(
                "INSERT INTO block (p,q,x,y,z,w) VALUES (1,-1,44,180,-10,6)", [],
            ).unwrap();
        }
        update_animals_at(&server, 300).unwrap();
        assert_eq!(server.state.lock().unwrap().animals.len(), 1);
        assert!(is_sky_park(-28, 180, -25));
        assert!(is_sky_park(28, 200, 28));
        assert!(!is_sky_park(29, 180, 0));
        assert!(!is_sky_park(0, 179, 0));
    }

    #[test]
    fn mempool_snapshot_updates_the_herd_without_an_eight_animal_cap() {
        let (server, _, _) = setup();
        let txids: BTreeSet<_> = (0..12).map(|id| format!("{id:064x}")).collect();
        {
            let mut state = server.state.lock().unwrap();
            for player in state.players.values_mut() {
                player.position = [0.0, 200.5, 0.0, 0.0, 0.0];
            }
            for step in 0..32 {
                let angle = f64::from(step) * std::f64::consts::TAU / 32.0;
                let x = (angle.cos() * 12.0).round() as i32;
                let z = (angle.sin() * 12.0).round() as i32;
                state
                    .db
                    .execute(
                        "INSERT OR REPLACE INTO block (p,q,x,y,z,w) VALUES (?1,?2,?3,179,?4,6)",
                        params![chunked(x), chunked(z), x, z],
                    )
                    .unwrap();
            }
            state.mempool = txids.clone();
        }
        update_animals_at(&server, 300).unwrap();
        let mut state = server.state.lock().unwrap();
        assert_eq!(state.animals.len(), 12);
        assert_eq!(
            state
                .animals
                .iter()
                .map(|a| a.txid.clone())
                .collect::<BTreeSet<_>>(),
            txids
        );
        let survivor = state.animals[0].clone();
        state.mempool.retain(|txid| *txid == survivor.txid);
        drop(state);
        update_animals_at(&server, 300).unwrap();
        let state = server.state.lock().unwrap();
        assert_eq!(state.animals.len(), 1);
        assert_eq!(state.animals[0].id, survivor.id);
    }

    #[test]
    fn night_boundaries_match_the_daylight_cycle() {
        assert!(is_night(0));
        assert!(is_night(149));
        assert!(!is_night(150));
        assert!(!is_night(509));
        assert!(is_night(510));
        assert!(is_night(600));
    }

    #[test]
    fn pickaxe_restores_a_zombie_until_the_next_night() {
        let (server, first, second) = setup();
        {
            let mut state = server.state.lock().unwrap();
            state.players.get_mut(&1).unwrap().position = [0.0, 202.0, 0.0, 0.0, 0.0];
            state.players.get_mut(&2).unwrap().position = [20.0, 202.0, 0.0, 0.0, 0.0];
            let txid = "a".repeat(64);
            state.mempool.insert(txid.clone());
            state.animals.push(Animal { id: 1, txid, x: 0.0, y: 200.5, z: -3.0, heading: 0, pacified: false });
            state.db.execute("INSERT INTO block (p,q,x,y,z,w) VALUES (0,-1,0,202,-1,6)", []).unwrap();
            for z in -2..=1 {
                state.db.execute(
                    "INSERT INTO block (p,q,x,y,z,w) VALUES (0,?1,0,200,?2,6)",
                    params![chunked(z), z],
                ).unwrap();
            }
        }
        let now = Instant::now();
        hit_animal(&server, 1, 1, 0, now).unwrap();
        assert!(!server.state.lock().unwrap().animals[0].pacified);
        {
            let state = server.state.lock().unwrap();
            state.db.execute("DELETE FROM block WHERE x=0 AND y=202 AND z=-1", []).unwrap();
        }
        hit_animal(&server, 1, 1, 150, now + Duration::from_secs(1)).unwrap();
        assert!(!server.state.lock().unwrap().animals[0].pacified);
        assert!(!first.try_iter().any(|m| m == b"ZH\n"));
        hit_animal(&server, 1, 1, 0, now + Duration::from_secs(2)).unwrap();
        assert!(server.state.lock().unwrap().animals[0].pacified);
        let messages = String::from_utf8(first.try_iter().flatten().collect()).unwrap();
        assert!(messages.contains(",aaaaaa...aaaaaa,1\n"));
        assert!(messages.contains("ZH\n"));
        assert!(!second.try_iter().any(|m| m == b"ZH\n"));
        {
            let mut state = server.state.lock().unwrap();
            state.animals[0].z = -0.8;
            state.animals[0].heading = 2;
        }
        update_animals_at(&server, 0).unwrap();
        assert_eq!(server.state.lock().unwrap().players[&1].lives, 10);
        update_animals_at(&server, 150).unwrap();
        assert!(!server.state.lock().unwrap().animals[0].pacified);
        update_animals_at(&server, 510).unwrap();
        assert_eq!(server.state.lock().unwrap().players[&1].lives, 9);
    }

    #[test]
    fn zombies_chase_attack_and_respawn_only_the_target() {
        let (server, first, second) = setup();
        {
            let mut state = server.state.lock().unwrap();
            state.players.get_mut(&1).unwrap().position = [3.0, 202.0, 0.0, 0.0, 0.0];
            state.players.get_mut(&2).unwrap().position = [20.0, 202.0, 0.0, 0.0, 0.0];
            state.players.get_mut(&1).unwrap().inventory[6] = 4;
            state.players.get_mut(&1).unwrap().inventory[MINA_ORE as usize] = 2;
            state.players.get_mut(&2).unwrap().inventory[6] = 3;
            for x in 0..=3 {
                state
                    .db
                    .execute(
                        "INSERT INTO block (p,q,x,y,z,w) VALUES (0,0,?1,200,0,6)",
                        [x],
                    )
                    .unwrap();
            }
            let txid = "a".repeat(64);
            state.mempool.insert(txid.clone());
            state.animals.push(Animal {
                id: 1,
                txid,
                x: 0.0,
                y: 200.5,
                z: 0.0,
                heading: 0,
                pacified: false,
            });
        }
        update_animals_at(&server, 0).unwrap();
        assert!(server.state.lock().unwrap().animals[0].x > 0.0);
        assert_eq!(server.state.lock().unwrap().players[&1].lives, 10);
        update_animals_at(&server, 1).unwrap();
        assert_eq!(server.state.lock().unwrap().players[&1].lives, 9);
        assert_eq!(server.state.lock().unwrap().players[&1].inventory[6], 4);
        update_animals_at(&server, 2).unwrap();
        assert_eq!(server.state.lock().unwrap().players[&1].lives, 9);
        assert_eq!(server.state.lock().unwrap().players[&2].lives, 10);
        {
            let mut state = server.state.lock().unwrap();
            state.players.get_mut(&1).unwrap().lives = 1;
        }
        update_animals_at(&server, 3).unwrap();
        let state = server.state.lock().unwrap();
        assert_eq!(state.players[&1].lives, 10);
        assert_eq!(state.players[&1].position, [0.0; 5]);
        assert_eq!(state.players[&1].inventory, [0; 256]);
        assert_eq!(state.players[&2].lives, 10);
        assert_eq!(state.players[&2].inventory[6], 3);
        drop(state);
        let first_messages = first
            .try_iter()
            .map(|m| String::from_utf8(m).unwrap())
            .collect::<String>();
        let second_messages = second
            .try_iter()
            .map(|m| String::from_utf8(m).unwrap())
            .collect::<String>();
        assert!(first_messages.contains("ZN,1\n"));
        assert!(first_messages.contains("HP,9\n"));
        assert!(first_messages.contains("ZD\n"));
        assert!(first_messages.contains("HP,10\n"));
        assert!(!second_messages.contains("HP,"));
        update_animals_at(&server, 150).unwrap();
        assert!(first.try_iter().any(|m| m == b"ZN,0\n"));
    }

    #[test]
    fn players_can_mine_below_bedrock_but_cannot_remove_the_roof() {
        let (server, _, _) = setup();
        server.state.lock().unwrap().players.get_mut(&1).unwrap().position =
            [20.0, -4.0, 0.0, 0.0, 0.0];
        block_edit(&server, 1, 20, 0, 0, 0).unwrap();
        assert_eq!(server.state.lock().unwrap().players[&1].inventory[BEDROCK as usize], 0);

        server.state.lock().unwrap().players.get_mut(&1).unwrap().position =
            [20.0, -18.0, 0.0, 0.0, 0.0];
        block_edit(&server, 1, 20, -20, 0, 0).unwrap();
        assert_eq!(server.state.lock().unwrap().players[&1].inventory[6], 1);
    }

    #[test]
    fn both_liquids_drain_behind_a_dam_and_refill_across_the_chunk_seam() {
        let (server, first, _) = setup();
        for (z, material) in [(12, 12), (52, 13)] {
            let q = chunked(z);
            {
                let mut state = server.state.lock().unwrap();
                let player = state.players.get_mut(&1).unwrap();
                player.position = [29.0, -16.0, f64::from(z), 0.0, 0.0];
                player.inventory[6] = 5;
            }
            for dam_z in z - 2..=z + 2 {
                block_edit(&server, 1, 30, -17, dam_z, 6).unwrap();
            }
            advance_flows(&mut server.state.lock().unwrap());
            let drain = first.try_iter().map(|m| String::from_utf8(m).unwrap()).collect::<String>();
            assert!(drain.contains(&format!("FL,0,{q},31,-17,{z},0\n")));
            assert!(drain.contains(&format!("FL,1,{q},32,-17,{z},0\n")));
            assert!(!drain.contains(&format!("FL,0,{q},30,-17,{z},0\n")));

            chunk_response(&server, 1, 1, q, -1).unwrap();
            let snapshot = String::from_utf8(first.try_recv().unwrap()).unwrap();
            assert!(snapshot.contains(&format!("FL,1,{q},32,-17,{z},0\n")));

            block_edit(&server, 1, 30, -17, z, 0).unwrap();
            advance_flows(&mut server.state.lock().unwrap());
            let initial = first.try_iter().map(|m| String::from_utf8(m).unwrap()).collect::<String>();
            assert!(initial.contains(&format!("FL,0,{q},30,-17,{z},{material}\n")));
            assert!(!initial.contains(&format!("FL,1,{q},32,-17,{z},{material}\n")));
            for _ in 0..5 {
                advance_flows(&mut server.state.lock().unwrap());
            }
            let refill = first.try_iter().map(|m| String::from_utf8(m).unwrap()).collect::<String>();
            assert!(refill.contains(&format!("FL,0,{q},31,-17,{z},{material}\n")));
            assert!(refill.contains(&format!("FL,1,{q},32,-17,{z},{material}\n")));
            assert!(refill.contains(&format!("FL,1,{q},33,-18,{z},{material}\n")));
        }
    }

    #[test]
    fn underworld_streams_drop_across_chunk_edges_and_leave_bedrock_openings() {
        let mut terrain = Terrain::default();
        let west = terrain.chunk(0, 0);
        let east = terrain.chunk(1, 0);
        let lava = terrain.chunk(1, 1);
        assert_eq!(west[&(16, -24, 16)], BEDROCK);
        assert!(!west.contains_key(&(16, 0, 16)));
        assert!(!west.contains_key(&(16, 3, 16)));
        assert_eq!(west[&(20, 0, 16)], BEDROCK);
        for (z, material, chunk) in [(12, 12, east), (52, 13, lava)] {
            // The stream crosses the chunk boundary and continues over a drop.
            assert_eq!(chunk[&(31, -17, z)], -material);
            assert_eq!(chunk[&(32, -17, z)], material);
            assert_eq!(chunk[&(33, -17, z)], material);
            assert_eq!(chunk[&(33, -18, z)], material);
            assert_eq!(chunk[&(33, -19, z)], 6);
            assert!(!chunk.contains_key(&(33, -16, z)));
        }
    }

    #[test]
    fn zombies_pursue_across_a_stepped_slope_in_both_directions() {
        for rise in [-1, 1] {
            let (server, _, _) = setup();
            {
                let mut state = server.state.lock().unwrap();
                let player_y = f64::from(200 + 6 * rise) + 2.0;
                state.players.get_mut(&1).unwrap().position = [6.0, player_y, 0.0, 0.0, 0.0];
                for x in 0..=6 {
                    state.db.execute(
                        "INSERT INTO block (p,q,x,y,z,w) VALUES (0,0,?1,?2,0,6)",
                        params![x, 200 + x * rise],
                    ).unwrap();
                }
                let txid = "a".repeat(64);
                state.mempool.insert(txid.clone());
                state.animals.push(Animal {
                    id: 1,
                    txid,
                    x: 0.0,
                    y: 200.5,
                    z: 0.0,
                    heading: 3,
                    pacified: false,
                });
            }
            update_animals_at(&server, 0).unwrap();
            {
                let state = server.state.lock().unwrap();
                assert!(state.animals[0].x > 1.0);
                assert_eq!(state.animals[0].y, 200.5 + f64::from(rise));
            }
            for step in 1..=5 {
                update_animals_at(&server, step).unwrap();
            }
            let state = server.state.lock().unwrap();
            assert!(state.animals[0].x >= 5.0);
            assert!(state.players[&1].lives < PLAYER_LIVES);
        }
    }

    #[test]
    fn zombies_do_not_attack_through_walls_or_during_day() {
        let (server, _, _) = setup();
        {
            let mut state = server.state.lock().unwrap();
            state.players.get_mut(&1).unwrap().position = [1.2, 202.0, 0.0, 0.0, 0.0];
            state.players.get_mut(&2).unwrap().position = [20.0, 202.0, 0.0, 0.0, 0.0];
            for (x, y) in [(0, 200), (1, 200), (1, 201), (1, 202)] {
                state
                    .db
                    .execute(
                        "INSERT INTO block (p,q,x,y,z,w) VALUES (0,0,?1,?2,0,6)",
                        params![x, y],
                    )
                    .unwrap();
            }
            let txid = "a".repeat(64);
            state.mempool.insert(txid.clone());
            state.animals.push(Animal {
                id: 1,
                txid,
                x: 0.0,
                y: 200.5,
                z: 0.0,
                heading: 1,
                pacified: false,
            });
        }
        update_animals_at(&server, 0).unwrap();
        assert_eq!(server.state.lock().unwrap().players[&1].lives, 10);
        {
            let state = server.state.lock().unwrap();
            state
                .db
                .execute("DELETE FROM block WHERE x=1 AND y>200", [])
                .unwrap();
        }
        update_animals_at(&server, 150).unwrap();
        assert_eq!(server.state.lock().unwrap().players[&1].lives, 10);
        update_animals_at(&server, 510).unwrap();
        assert_eq!(server.state.lock().unwrap().players[&1].lives, 9);
    }

    #[test]
    fn mempool_http_response_distinguishes_empty_from_unavailable() {
        let txid = "A".repeat(64);
        let response = format!("HTTP/1.1 200 OK\r\nContent-Length: 65\r\n\r\n{txid}\n");
        assert_eq!(
            read_mempool_response(response.as_bytes()).unwrap(),
            BTreeSet::from(["a".repeat(64)])
        );
        assert!(
            read_mempool_response(&b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n"[..])
                .unwrap()
                .is_empty()
        );
        assert!(read_mempool_response(&b"HTTP/1.1 503 Service Unavailable\r\n\r\n"[..]).is_err());
        assert!(
            read_mempool_response(&b"HTTP/1.1 200 OK\r\nContent-Length: 65\r\n\r\n"[..]).is_err()
        );
    }
}
