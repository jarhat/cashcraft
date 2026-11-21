use crate::{chunked, world_stream, world_stream_direction, CHUNK_SIZE};
use rusqlite::{params, Connection};
use std::collections::{HashMap, HashSet, VecDeque};

pub type Cell = (i32, i32, i32);
pub type Region = (i32, i32);
type Wet = HashMap<Cell, (i32, usize)>;
const SIZE: i32 = CHUNK_SIZE * 2;

pub fn region(x: i32, z: i32) -> Region {
    (chunked(x) & !1, chunked(z) & !1)
}

fn stream(x: i32, z: i32) -> (i32, i32, i32) {
    let (mut bottom, mut top) = (0, 0);
    let material = unsafe { world_stream(x, z, &mut bottom, &mut top) };
    (material, bottom, top)
}

pub fn is_channel((x, y, z): Cell) -> bool {
    let (material, bottom, top) = stream(x, z);
    material != 0 && (bottom..=top).contains(&y)
}

pub struct Channel {
    cells: HashMap<Cell, i32>,
    sources: Vec<Cell>,
    blocked: HashSet<Cell>,
}

impl Channel {
    pub fn load(db: &Connection, (p, q): Region) -> rusqlite::Result<Option<Self>> {
        let mut query = db.prepare_cached(
            "SELECT p,q,x,y,z,w FROM block WHERE p IN (?1,?2) AND q IN (?3,?4) AND y < 0",
        )?;
        let mut rows = query.query(params![p, p + 1, q, q + 1])?;
        let mut blocked = HashSet::new();
        let mut has_edits = false;
        while let Some(row) = rows.next()? {
            let (x, y, z) = (row.get(2)?, row.get(3)?, row.get(4)?);
            let cell = (x, y, z);
            if chunked(x) == row.get::<_, i32>(0)?
                && chunked(z) == row.get::<_, i32>(1)?
                && is_channel(cell)
            {
                has_edits = true;
                if row.get::<_, i32>(5)? != 0 {
                    blocked.insert(cell);
                }
            }
        }
        if !has_edits {
            return Ok(None);
        }
        Ok(Some(Self::new((p, q), blocked)))
    }

    fn new((p, q): Region, blocked: HashSet<Cell>) -> Self {
        let mut cells = HashMap::new();
        let mut sources = Vec::new();
        for dx in 0..SIZE {
            for dz in 0..SIZE {
                let (x, z) = (p * CHUNK_SIZE + dx, q * CHUNK_SIZE + dz);
                let (material, bottom, top) = stream(x, z);
                if material != 0 {
                    for y in bottom..=top {
                        cells.insert((x, y, z), material);
                    }
                    if dx == 0 || dx == SIZE - 1 {
                        sources.push((x, top, z));
                    }
                }
            }
        }
        Self {
            cells,
            sources,
            blocked,
        }
    }

    pub fn reachable(&self) -> Wet {
        let mut wet = Wet::new();
        let mut queue = VecDeque::new();
        for &source in &self.sources {
            if !self.blocked.contains(&source) {
                queue.push_back(source);
                wet.insert(source, (self.cells[&source], 0));
            }
        }
        while let Some((x, y, z)) = queue.pop_front() {
            let (material, depth) = wet[&(x, y, z)];
            let downhill = unsafe { world_stream_direction(x) };
            for next in [
                (x, y - 1, z),
                (x + downhill, y, z),
                (x, y, z - 1),
                (x, y, z + 1),
            ] {
                if self.cells.get(&next) == Some(&material)
                    && !self.blocked.contains(&next)
                    && !wet.contains_key(&next)
                {
                    wet.insert(next, (material, depth + 1));
                    queue.push_back(next);
                }
            }
        }
        wet
    }

    pub fn settled(db: &Connection, region: Region) -> rusqlite::Result<Wet> {
        Ok(Self::load(db, region)?
            .unwrap_or_else(|| Self::new(region, HashSet::new()))
            .reachable())
    }

    pub fn snapshot(&self, wet: &Wet, p: i32, q: i32, output: &mut String) {
        let (left, front) = (p * CHUNK_SIZE, q * CHUNK_SIZE);
        for &(x, y, z) in self.cells.keys() {
            let cell = (x, y, z);
            if (left - 1..=left + CHUNK_SIZE).contains(&x)
                && (front - 1..=front + CHUNK_SIZE).contains(&z)
                && !self.blocked.contains(&cell)
            {
                let sign = if chunked(x) == p && chunked(z) == q {
                    1
                } else {
                    -1
                };
                let material = wet.get(&cell).map_or(0, |v| v.0);
                push_packet(output, p, q, cell, material * sign);
            }
        }
    }
}

pub struct Flow {
    pub channel: Channel,
    pub wet: Wet,
    target: Wet,
}

impl Flow {
    pub fn new(channel: Channel, mut wet: Wet) -> Self {
        wet.retain(|cell, _| !channel.blocked.contains(cell));
        let target = channel.reachable();
        Self {
            channel,
            wet,
            target,
        }
    }

    pub fn advance(&mut self, output: &mut String) -> bool {
        self.wet.retain(|&cell, _| {
            let connected = self.target.contains_key(&cell);
            if !connected {
                push_cell(output, cell, 0);
            }
            connected
        });
        if let Some(depth) = self
            .target
            .iter()
            .filter(|(cell, _)| !self.wet.contains_key(cell))
            .map(|(_, (_, depth))| *depth)
            .min()
        {
            for (&cell, &(material, distance)) in &self.target {
                if distance == depth && self.wet.insert(cell, (material, distance)).is_none() {
                    push_cell(output, cell, material);
                }
            }
        }
        self.wet.len() != self.target.len()
    }
}

fn push_cell(output: &mut String, (x, y, z): Cell, material: i32) {
    let (p, q) = (chunked(x), chunked(z));
    for cp in chunked(x - 1)..=chunked(x + 1) {
        for cq in chunked(z - 1)..=chunked(z + 1) {
            let value = if cp == p && cq == q {
                material
            } else {
                -material
            };
            push_packet(output, cp, cq, (x, y, z), value);
        }
    }
}

fn push_packet(output: &mut String, p: i32, q: i32, (x, y, z): Cell, material: i32) {
    use std::fmt::Write as _;
    let _ = writeln!(output, "FL,{p},{q},{x},{y},{z},{material}");
}
