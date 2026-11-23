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

pub fn natural_material((x, y, z): Cell) -> i32 {
    let (material, bottom, top) = stream(x, z);
    if (bottom..=top).contains(&y) { material } else { 0 }
}

pub fn can_spill((x, y, z): Cell) -> bool {
    if !(crate::DEEP_BEDROCK_Y + 1..=-8).contains(&y) {
        return false;
    }
    for dx in -7_i32..=7 {
        for dz in -(7 - dx.abs())..=(7 - dx.abs()) {
            let (material, _, top) = stream(x + dx, z + dz);
            if material != 0 && y <= top {
                return true;
            }
        }
    }
    false
}

pub struct Channel {
    cells: HashMap<Cell, i32>,
    sources: Vec<Cell>,
    blocked: HashSet<Cell>,
    openings: HashSet<Cell>,
}

impl Channel {
    pub fn load(db: &Connection, (p, q): Region) -> rusqlite::Result<Option<Self>> {
        let mut query = db.prepare_cached(
            "SELECT p,q,x,y,z,w FROM block WHERE p IN (?1,?2) AND q IN (?3,?4) AND y < 0",
        )?;
        let mut rows = query.query(params![p, p + 1, q, q + 1])?;
        let mut blocked = HashSet::new();
        let mut openings = HashSet::new();
        let mut has_edits = false;
        while let Some(row) = rows.next()? {
            let (x, y, z) = (row.get(2)?, row.get(3)?, row.get(4)?);
            let cell = (x, y, z);
            if chunked(x) == row.get::<_, i32>(0)?
                && chunked(z) == row.get::<_, i32>(1)?
            {
                let w = row.get::<_, i32>(5)?;
                if is_channel(cell) {
                    has_edits = true;
                    if w != 0 {
                        blocked.insert(cell);
                    }
                } else if w == 0 && can_spill(cell) {
                    openings.insert(cell);
                }
            }
        }
        if !has_edits && openings.is_empty() {
            return Ok(None);
        }
        Ok(Some(Self::new((p, q), blocked, openings)))
    }

    fn new((p, q): Region, blocked: HashSet<Cell>, openings: HashSet<Cell>) -> Self {
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
            openings,
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
        let mut edges: Vec<_> = wet.keys().copied().collect();
        edges.sort_unstable_by_key(|cell| (wet[cell].1, *cell));
        // Follow gravity first; each spill has a bounded budget beyond its channel.
        let mut spills = VecDeque::new();
        for cell in edges {
            let (material, distance) = wet[&cell];
            spills.push_back((cell, material, distance, 0));
        }
        while let Some(((x, y, z), material, distance, used)) = spills.pop_front() {
            if used >= if material == 13 { 3 } else { 7 } {
                continue;
            }
            let down = (x, y - 1, z);
            let options = [down, (x - 1, y, z), (x + 1, y, z), (x, y, z - 1), (x, y, z + 1)];
            let choices = if self.openings.contains(&down) { &options[..1] } else { &options[1..] };
            for &next in choices {
                if self.openings.contains(&next) && !wet.contains_key(&next) {
                    wet.insert(next, (material, distance + 1));
                    spills.push_back((next, material, distance + 1, used + 1));
                }
            }
        }
        wet
    }

    pub fn settled(db: &Connection, region: Region) -> rusqlite::Result<Wet> {
        Ok(Self::load(db, region)?
            .unwrap_or_else(|| Self::new(region, HashSet::new(), HashSet::new()))
            .reachable())
    }

    pub fn snapshot(&self, wet: &Wet, p: i32, q: i32, output: &mut String) {
        let (left, front) = (p * CHUNK_SIZE, q * CHUNK_SIZE);
        for &(x, y, z) in self.cells.keys().chain(self.openings.iter()) {
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

    pub fn material(&self, wet: &Wet, cell: Cell) -> Option<i32> {
        if !self.blocked.contains(&cell) &&
            (self.cells.contains_key(&cell) || self.openings.contains(&cell)) {
            Some(wet.get(&cell).map_or(0, |v| v.0))
        } else {
            None
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
        wet.retain(|cell, _| !channel.blocked.contains(cell) &&
            (channel.cells.contains_key(cell) || channel.openings.contains(cell)));
        let target = channel.reachable();
        Self {
            channel,
            wet,
            target,
        }
    }

    pub fn advance(&mut self, output: &mut String) -> bool {
        self.wet.retain(|&cell, value| {
            let connected = self.target.get(&cell).is_some_and(|v| v.0 == value.0);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spills_fall_first_and_water_travels_farther_than_lava() {
        let source = (20, -15, 20);
        let falling = (20, -16, 20);
        let side = (20, -15, 21);
        let openings: HashSet<_> = [falling, side].into_iter()
            .chain((21..=28).map(|x| (x, -16, 20)))
            .collect();
        for (liquid, distance) in [(12, 7), (13, 3)] {
            let mut channel = Channel {
                cells: HashMap::from([(source, liquid)]),
                sources: vec![source],
                blocked: HashSet::new(),
                openings: openings.clone(),
            };
            let wet = channel.reachable();
            assert_eq!(wet.get(&falling), Some(&(liquid, 1)));
            assert!(!wet.contains_key(&side));
            assert!(wet.contains_key(&(20 + distance - 1, -16, 20)));
            assert!(!wet.contains_key(&(20 + distance, -16, 20)));
            channel.blocked.insert(source);
            let mut flow = Flow::new(channel, wet);
            let mut updates = String::new();
            assert!(!flow.advance(&mut updates));
            assert!(updates.contains("FL,0,0,20,-16,20,0\n"));
        }
    }
}
