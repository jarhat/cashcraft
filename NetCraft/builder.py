"""Build a customizable CashToken sky park in a NEW Rust-server world.

Run before starting the server:

    python3 NetCraft/builder.py
    python3 NetCraft/builder.py --init-park data/netcraft.db
    python3 NetCraft/builder.py --add-park data/existing-world.db

With no arguments, a new Compose world is created at data/netcraft.db. An
existing database is never replaced; use --add-park only after stopping the
server and backing up the world.
Stop the server before running either command. --init-park creates a new
database; --add-park requires an existing Rust-server world and preserves
existing block, light and sign edits, skipping park blocks at those positions.
Back up existing worlds before building.
It requires a C compiler and the checked-in terrain sources so it can clear
only blocks that actually exist in the server's generated terrain.

Customize PARK_*, SKY_Y, TOWER_Z and the drawing functions in make_park().
Coordinates are block coordinates, with (0, 0) at the player spawn. The
central park connects to four floating garden islands by bridges. A single
pillar supports the upper platform; double-tap the keyboard jump key to fly.
Set DONATION_ADDRESS below to add a block-built donation QR (requires segno).
The seven gold spheres are decorative, not interactive. Block IDs match NetCraft/src/item.h;
the original shape helpers are also available. The natural world remains
outside the tower.
Always test changes in a new world and back up any world you want to keep.
"""

import argparse
from contextlib import closing
import ctypes
import math
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import sys
import tempfile

DEFAULT_HOST = '127.0.0.1'
DEFAULT_PORT = 4080

EMPTY = 0
GRASS = 1
SAND = 2
STONE = 3
BRICK = 4
WOOD = 5
CEMENT = 6
DIRT = 7
PLANK = 8
SNOW = 9
GLASS = 10
COBBLE = 11
WATER = 12
LAVA = 13
CHEST = 14
LEAVES = 15
CLOUD = 16
TALL_GRASS = 17
YELLOW_FLOWER = 18
RED_FLOWER = 19
COLOR_WHITE = 32
COLOR_GOLD = 36
COLOR_CYAN = 41
COLOR_PURPLE = 42
COLOR_BLUE = 43
COLOR_GREEN = 45
COLOR_RED = 46
COLOR_BLACK = 47

# Platform and tower coordinates. Keep the platform below the 255-block limit.
PARK_HALF_WIDTH = 28
PARK_Z_MIN = -25
PARK_Z_MAX = 28
WORLD_HALF_WIDTH = 70
WORLD_Z_MIN = -70
WORLD_Z_MAX = 70
SKY_Y = 180
TOWER_Z = -12
DONATION_ADDRESS = ""  # Set a Bitcoin Cash donation address before building the QR.
DONATION_QR_Z = 24
TREE_POSITIONS = [(-21, -11), (21, -11), (-21, 14), (21, 14)]
SPHERE_POSITIONS = [(-58, -4), (-58, 4), (58, -4), (58, 4),
                    (-5, -58), (5, -58), (-5, 58)]

OFFSETS = [
    (-0.5, -0.5, -0.5),
    (-0.5, -0.5, 0.5),
    (-0.5, 0.5, -0.5),
    (-0.5, 0.5, 0.5),
    (0.5, -0.5, -0.5),
    (0.5, -0.5, 0.5),
    (0.5, 0.5, -0.5),
    (0.5, 0.5, 0.5),
]

def sphere(cx, cy, cz, r, fill=False, fx=False, fy=False, fz=False):
    result = set()
    for x in range(cx - r, cx + r + 1):
        if fx and x != cx:
            continue
        for y in range(cy - r, cy + r + 1):
            # if y < cy:
            #     continue # top hemisphere only
            if fy and y != cy:
                continue
            for z in range(cz - r, cz + r + 1):
                if fz and z != cz:
                    continue
                inside = False
                outside = fill
                for dx, dy, dz in OFFSETS:
                    ox, oy, oz = x + dx, y + dy, z + dz
                    d2 = (ox - cx) ** 2 + (oy - cy) ** 2 + (oz - cz) ** 2
                    d = d2 ** 0.5
                    if d < r:
                        inside = True
                    else:
                        outside = True
                if inside and outside:
                    result.add((x, y, z))
    return result

def circle_x(x, y, z, r, fill=False):
    return sphere(x, y, z, r, fill, fx=True)

def circle_y(x, y, z, r, fill=False):
    return sphere(x, y, z, r, fill, fy=True)

def circle_z(x, y, z, r, fill=False):
    return sphere(x, y, z, r, fill, fz=True)

def cylinder_x(x1, x2, y, z, r, fill=False):
    x1, x2 = sorted((x1, x2))
    result = set()
    for x in range(x1, x2 + 1):
        result |= circle_x(x, y, z, r, fill)
    return result

def cylinder_y(x, y1, y2, z, r, fill=False):
    y1, y2 = sorted((y1, y2))
    result = set()
    for y in range(y1, y2 + 1):
        result |= circle_y(x, y, z, r, fill)
    return result

def cylinder_z(x, y, z1, z2, r, fill=False):
    z1, z2 = sorted((z1, z2))
    result = set()
    for z in range(z1, z2 + 1):
        result |= circle_z(x, y, z, r, fill)
    return result

def cuboid(x1, x2, y1, y2, z1, z2, fill=True):
    x1, x2 = sorted((x1, x2))
    y1, y2 = sorted((y1, y2))
    z1, z2 = sorted((z1, z2))
    result = set()
    a = (x1 == x2) + (y1 == y2) + (z1 == z2)
    for x in range(x1, x2 + 1):
        for y in range(y1, y2 + 1):
            for z in range(z1, z2 + 1):
                n = 0
                n += x in (x1, x2)
                n += y in (y1, y2)
                n += z in (z1, z2)
                if not fill and n <= a:
                    continue
                result.add((x, y, z))
    return result

def pyramid(x1, x2, y, z1, z2, fill=False):
    x1, x2 = sorted((x1, x2))
    z1, z2 = sorted((z1, z2))
    result = set()
    while x2 >= x1 and z2 >= z2:
        result |= cuboid(x1, x2, y, y, z1, z2, fill)
        y, x1, x2, z1, z2 = y + 1, x1 + 1, x2 - 1, z1 + 1, z2 - 1
    return result

def get_identity():
    query = (
        'select username, token from identity_token where selected = 1;'
    )
    conn = sqlite3.connect('auth.db')
    rows = conn.execute(query)
    for row in rows:
        return row
    raise Exception('No identities found.')

class Client(object):
    def __init__(self, host, port):
        self.conn = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.conn.connect((host, port))
        self.authenticate()
    def authenticate(self):
        import requests
        username, identity_token = get_identity()
        url = 'https://craft.michaelfogleman.com/api/1/identity'
        payload = {
            'username': username,
            'identity_token': identity_token,
        }
        response = requests.post(url, data=payload)
        if response.status_code == 200 and response.text.isalnum():
            access_token = response.text
            self.conn.sendall(('A,%s,%s\n' % (username, access_token)).encode())
        else:
            raise Exception('Failed to authenticate.')
    def set_block(self, x, y, z, w):
        self.conn.sendall(('B,%d,%d,%d,%d\n' % (x, y, z, w)).encode())
    def set_blocks(self, blocks, w):
        key = lambda block: (block[1], block[0], block[2])
        for x, y, z in sorted(blocks, key=key):
            self.set_block(x, y, z, w)
    def bitmap(self, sx, sy, sz, d1, d2, data, lookup):
        x, y, z = sx, sy, sz
        dx1, dy1, dz1 = d1
        dx2, dy2, dz2 = d2
        for row in data:
            x = sx if dx1 else x
            y = sy if dy1 else y
            z = sz if dz1 else z
            for c in row:
                w = lookup.get(c)
                if w is not None:
                    self.set_block(x, y, z, w)
                x, y, z = x + dx1, y + dy1, z + dz1
            x, y, z = x + dx2, y + dy2, z + dz2

def get_client():
    default_args = [DEFAULT_HOST, DEFAULT_PORT]
    args = sys.argv[1:] + [None] * len(default_args)
    host, port = [a or b for a, b in zip(args, default_args)]
    client = Client(host, int(port))
    return client

def terrain_in_park():
    """Use exactly the server's C generator, including trees and other plants."""
    root = Path(__file__).resolve().parent
    sources = [root / "deps/noise/noise.c"]
    sources.extend(root / "src/worldgen" / name for name in (
        "world.c", "base_terrain.c", "biome_desert.c", "biome_rainforest.c",
        "biome_taiga.c", "biome_temperate.c",
    ))
    terrain = {}
    with tempfile.TemporaryDirectory(prefix="netcraft-terrain-") as directory:
        library = Path(directory) / "terrain.so"
        subprocess.run(
            [os.environ.get("CC", "cc"), "-shared", "-fPIC", "-O2",
             "-I" + str(root / "deps/noise"), "-I" + str(root / "src"),
             *(str(source) for source in sources), "-lm", "-o", str(library)],
            check=True,
        )
        generator = ctypes.CDLL(str(library))
        callback_type = ctypes.CFUNCTYPE(
            None, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
            ctypes.c_void_p,
        )
        generator.create_world.argtypes = [
            ctypes.c_int, ctypes.c_int, callback_type, ctypes.c_void_p,
        ]
        generator.create_world.restype = None
        for p in range(-WORLD_HALF_WIDTH // 32, WORLD_HALF_WIDTH // 32 + 1):
            for q in range(WORLD_Z_MIN // 32, WORLD_Z_MAX // 32 + 1):
                def collect(x, y, z, w, _):
                    if (x // 32 == p and z // 32 == q and
                            -WORLD_HALF_WIDTH <= x <= WORLD_HALF_WIDTH and
                            WORLD_Z_MIN <= z <= WORLD_Z_MAX and w > 0):
                        terrain[x, y, z] = w
                callback = callback_type(collect)
                generator.create_world(p, q, callback, None)
    return terrain

def make_park(terrain):
    """Return absolute block edits; the last drawing at a position wins."""
    ground = [y for (x, y, z), w in terrain.items()
              if x == z == 0 and w in (GRASS, SAND, STONE, CEMENT, DIRT, SNOW, COBBLE)]
    if not ground:
        raise ValueError("Could not find natural ground at the park spawn")
    base = max(ground)
    floor = SKY_Y
    if not 31 <= base < floor - 4 or floor + 36 > 255:
        raise ValueError("Tower and park do not fit between spawn and world height limit")
    if any(y >= floor and w != CLOUD for (x, y, z), w in terrain.items()):
        raise ValueError("Sky platform intersects natural terrain; raise SKY_Y")
    edits = {}

    def put(x, y, z, block):
        if not (-WORLD_HALF_WIDTH <= x <= WORLD_HALF_WIDTH and
                WORLD_Z_MIN <= z <= WORLD_Z_MAX and 1 <= y <= 255):
            raise ValueError("Park structure extends outside its footprint")
        edits[x, y, z] = block

    def box(x1, x2, y1, y2, z1, z2, block):
        for position in cuboid(x1, x2, y1, y2, z1, z2):
            put(*position, block)

    # A one-block pillar supports the underside of a floating hemisphere.
    for y in range(base + 1, floor - 14):
        put(0, y, TOWER_Z, CEMENT)
    for x, y, z in sphere(0, floor, TOWER_Z, 15, fill=True):
        if y < floor:
            put(x, y, z, COBBLE if y < floor - 3 else DIRT)

    for x in range(-PARK_HALF_WIDTH, PARK_HALF_WIDTH + 1):
        for z in range(PARK_Z_MIN, PARK_Z_MAX + 1):
            path = abs(x) <= 3 or abs(z) <= 2
            put(x, floor, z, CEMENT if path else GRASS)
            if x in (-PARK_HALF_WIDTH, PARK_HALF_WIDTH) or z in (PARK_Z_MIN, PARK_Z_MAX):
                put(x, floor + 1, z, COLOR_WHITE)

    # Four layered evergreen trees with trunks, ornaments and golden stars.
    for tx, tz in TREE_POSITIONS:
        box(tx, tx, floor + 1, floor + 14, tz, tz, WOOD)
        for dy in range(3, 15):
            radius = max(0, (15 - dy) // 3)
            for dx in range(-radius, radius + 1):
                for dz in range(-radius, radius + 1):
                    if abs(dx) + abs(dz) <= radius + 1 and (dx or dz):
                        ornament = (abs(dx) + abs(dz) == radius and
                                    (dx + dz + dy) % 4 == 0)
                        put(tx + dx, floor + dy, tz + dz,
                            COLOR_RED if ornament else LEAVES)
        put(tx, floor + 15, tz, COLOR_GOLD)

    if DONATION_ADDRESS:
        try:
            import segno
        except ImportError as exc:
            raise RuntimeError("Install segno to build the configured donation QR") from exc
        qr = segno.make(DONATION_ADDRESS, error="m", micro=False)
        rows = list(qr.matrix_iter(border=4))
        if len(rows) > 49 or floor + len(rows) > 255:
            raise ValueError("Donation QR is too large for the park")
        for row, pixels in enumerate(rows):
            for column, pixel in enumerate(pixels):
                put(column - len(rows) // 2, floor + len(rows) - row,
                    DONATION_QR_Z, COLOR_BLACK if pixel else COLOR_WHITE)

    # A gold-rimmed CashToken-inspired coin with a block-letter B.
    cx, cz = 0, 12
    for dx in range(-6, 7):
        for dy in range(-6, 7):
            distance = dx * dx + dy * dy
            if distance <= 36:
                put(cx + dx, floor + 9 + dy, cz,
                    COLOR_GOLD if distance >= 25 else COLOR_GREEN)
    letter = ("11110", "10001", "10001", "11110", "10001", "10001", "11110")
    for dy, pixels in enumerate(letter):
        for dx, pixel in enumerate(pixels):
            if pixel == "1":
                put(cx - 2 + dx, floor + 12 - dy, cz - 1, COLOR_WHITE)
    box(cx - 1, cx + 1, floor + 1, floor + 2, cz, cz, COBBLE)

    # An original winged sky dragon, made of rounded segments and broad wings.
    # Change the body curve, colors and wing sweep here to customize it.
    for x in range(-22, 24):
        y = floor + 25 + round(2 * math.sin(x / 7))
        radius = 4 if x < 12 else 3
        for point in sphere(x, y, 0, radius, fill=True):
            put(*point, COLOR_GREEN)
        put(x, y - radius + 1, 0, COLOR_WHITE)
        if x % 4 == 0:
            put(x, y + radius, 0, COLOR_GOLD)
    box(-27, -21, floor + 23, floor + 29, -4, 4, COLOR_GREEN)
    box(-31, -27, floor + 22, floor + 25, -3, 3, COLOR_GREEN)
    for z in (-4, 4):
        put(-26, floor + 27, z, COLOR_WHITE)
        put(-27, floor + 27, z, COLOR_BLACK)
        box(-23, -22, floor + 30, floor + 33, z, z, COLOR_GOLD)
    for side in (-1, 1):
        for x in range(-12, 14):
            for distance in range(3, 19 - abs(x) // 2):
                put(x, floor + 28 + distance // 4, side * distance,
                    COLOR_GOLD if distance == 3 else COLOR_GREEN)
    for x in range(24, 35):
        put(x, floor + 24 - (x - 24) // 2, 0, COLOR_GREEN)

    # Four floating gardens linked to the central park, inspired by the
    # preview's green islands, waterfalls and small explorer structures.
    for axis, side in (("x", -1), ("x", 1), ("z", -1), ("z", 1)):
        cx, cz = (side * 53, 0) if axis == "x" else (0, side * 53)
        for dx in range(-11, 12):
            for dz in range(-11, 12):
                distance = dx * dx + dz * dz
                if distance > 121:
                    continue
                put(cx + dx, floor, cz + dz, GRASS)
                for depth in range(1, 6):
                    if distance <= (11 - depth) ** 2:
                        put(cx + dx, floor - depth, cz + dz,
                            DIRT if depth < 3 else COBBLE)
                if distance < 80 and (dx * 17 + dz * 13) % 29 == 0:
                    put(cx + dx, floor + 1, cz + dz,
                        (YELLOW_FLOWER, RED_FLOWER)[(dx + dz) % 2])
        start = PARK_HALF_WIDTH if axis == "x" else (PARK_Z_MAX if side > 0 else -PARK_Z_MIN)
        for distance in range(start, 44):
            for offset in range(-2, 3):
                x, z = (side * distance, offset) if axis == "x" else (offset, side * distance)
                put(x, floor, z, PLANK)
                put(x, floor + 1, z, EMPTY)
                if abs(offset) == 2 and distance % 3 == 0:
                    put(x, floor + 1, z, COLOR_WHITE)
        # A small open pavilion and a tree keep the islands recognizable
        # without turning the entire sky into dense geometry.
        for dx in (-3, 3):
            for dz in (-3, 3):
                box(cx + dx, cx + dx, floor + 1, floor + 5, cz + dz, cz + dz, WOOD)
        box(cx - 4, cx + 4, floor + 6, floor + 6, cz - 4, cz + 4, PLANK)
        box(cx - 3, cx + 3, floor + 7, floor + 7, cz - 3, cz + 3, COLOR_RED)
        put(cx, floor + 8, cz, COLOR_GOLD)
        tx, tz = cx + 6, cz + 5
        box(tx, tx, floor + 1, floor + 6, tz, tz, WOOD)
        for dx in range(-2, 3):
            for dz in range(-2, 3):
                for dy in range(4, 8):
                    if abs(dx) + abs(dz) + abs(dy - 5) <= 4 and (dx or dz):
                        put(tx + dx, floor + dy, tz + dz, LEAVES)
        # Water blocks form a static cascade; the game does not simulate flow.
        wx, wz = (cx + side * 9, cz) if axis == "x" else (cx, cz + side * 9)
        box(wx, wx, floor - 18, floor - 1, wz, wz, WATER)
    for gx, gz in SPHERE_POSITIONS:
        for point in sphere(gx, floor + 5, gz, 3, fill=True):
            put(*point, COLOR_GOLD)
    return edits

def park_rows(edits):
    """Include the mirrored chunk-edge entries expected by the server."""
    for (x, y, z), block in edits.items():
        p, q = x // 32, z // 32
        for dx in (-1, 0, 1):
            for dz in (-1, 0, 1):
                if dx and (x + dx) // 32 == p:
                    continue
                if dz and (z + dz) // 32 == q:
                    continue
                yield (p + dx, q + dz, x, y, z,
                       block if dx == dz == 0 else -block)

def initialize_park(path):
    """Create, but never replace, a database for the Rust server."""
    if Path(path).exists():
        raise FileExistsError("World already exists; back it up and use --add-park with the server stopped")
    terrain = terrain_in_park()
    edits = make_park(terrain)
    # Reserve the path atomically: a running or existing world is never modified.
    fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.close(fd)
    completed = False
    try:
        with closing(sqlite3.connect(path)) as db, db:
            db.execute("CREATE TABLE block (p INTEGER NOT NULL, q INTEGER NOT NULL, x INTEGER NOT NULL, y INTEGER NOT NULL, z INTEGER NOT NULL, w INTEGER NOT NULL)")
            db.execute("CREATE UNIQUE INDEX block_pqxyz_idx ON block (p,q,x,y,z)")
            db.executemany("INSERT INTO block VALUES (?,?,?,?,?,?)", park_rows(edits))
        completed = True
    finally:
        if not completed:
            os.unlink(path)
    print("Created %s with %d park edits. Start the server with this database." % (path, len(edits)))

def add_park(path):
    """Atomically add park blocks without changing any existing edits."""
    terrain = terrain_in_park()
    edits = make_park(terrain)
    with closing(sqlite3.connect(Path(path).resolve().as_uri() + "?mode=rw", uri=True, timeout=10)) as db:
        db.execute("BEGIN IMMEDIATE")
        try:
            occupied = set()
            for table in ("block", "light", "sign"):
                occupied.update(db.execute(
                    "SELECT DISTINCT x,y,z FROM " + table +
                    " WHERE x BETWEEN ? AND ? AND z BETWEEN ? AND ? AND y BETWEEN 1 AND 255",
                    (-WORLD_HALF_WIDTH, WORLD_HALF_WIDTH, WORLD_Z_MIN, WORLD_Z_MAX),
                ))
            accepted = {position: block for position, block in edits.items() if position not in occupied}
            db.executemany("INSERT INTO block VALUES (?,?,?,?,?,?)", park_rows(accepted))
            db.commit()
        except Exception:
            db.rollback()
            raise
    print("Added %d park edits to %s; preserved %d overlapping positions. Restart the server." %
          (len(accepted), path, len(edits) - len(accepted)))

def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    group = parser.add_mutually_exclusive_group()
    group.add_argument('--init-park', metavar='NEW_DATABASE')
    group.add_argument('--add-park', metavar='EXISTING_DATABASE')
    group.add_argument('--legacy-client', action='store_true',
                       help='run the original network builder instead')
    args = parser.parse_args()
    if not args.legacy_client:
        if args.add_park:
            add_park(args.add_park)
        else:
            path = Path(args.init_park) if args.init_park else Path(__file__).resolve().parent.parent / "data" / "netcraft.db"
            if not args.init_park:
                path.parent.mkdir(parents=True, exist_ok=True)
            initialize_park(path)
        return
    client = get_client()
    set_block = client.set_block
    set_blocks = client.set_blocks
    # set_blocks(circle_y(0, 32, 0, 16, True), STONE)
    # set_blocks(circle_y(0, 33, 0, 16), BRICK)
    # set_blocks(cuboid(-1, 1, 1, 31, -1, 1), CEMENT)
    # set_blocks(cuboid(-1024, 1024, 32, 32, -3, 3), STONE)
    # set_blocks(cuboid(-3, 3, 32, 32, -1024, 1024), STONE)
    # set_blocks(cuboid(-1024, 1024, 33, 33, -3, -3), BRICK)
    # set_blocks(cuboid(-1024, 1024, 33, 33, 3, 3), BRICK)
    # set_blocks(cuboid(-3, -3, 33, 33, -1024, 1024), BRICK)
    # set_blocks(cuboid(3, 3, 33, 33, -1024, 1024), BRICK)
    # set_blocks(sphere(0, 32, 0, 16), GLASS)
    # for y in range(1, 32):
    #     set_blocks(circle_y(0, y, 0, 4, True), CEMENT)
    # set_blocks(circle_x(16, 33, 0, 3), BRICK)
    # set_blocks(circle_x(-16, 33, 0, 3), BRICK)
    # set_blocks(circle_z(0, 33, 16, 3), BRICK)
    # set_blocks(circle_z(0, 33, -16, 3), BRICK)
    # for x in range(0, 1024, 32):
    #     set_blocks(cuboid(x - 1, x + 1, 31, 32, -1, 1), CEMENT)
    #     set_blocks(cuboid(-x - 1, -x + 1, 31, 32, -1, 1), CEMENT)
    #     set_blocks(cuboid(x, x, 1, 32, -1, 1), CEMENT)
    #     set_blocks(cuboid(-x, -x, 1, 32, -1, 1), CEMENT)
    # for z in range(0, 1024, 32):
    #     set_blocks(cuboid(-1, 1, 31, 32, z - 1, z + 1), CEMENT)
    #     set_blocks(cuboid(-1, 1, 31, 32, -z - 1, -z + 1), CEMENT)
    #     set_blocks(cuboid(-1, 1, 1, 32, z, z), CEMENT)
    #     set_blocks(cuboid(-1, 1, 1, 32, -z, -z), CEMENT)
    # for x in range(0, 1024, 8):
    #     set_block(x, 32, 0, CEMENT)
    #     set_block(-x, 32, 0, CEMENT)
    # for z in range(0, 1024, 8):
    #     set_block(0, 32, z, CEMENT)
    #     set_block(0, 32, -z, CEMENT)
    # set_blocks(pyramid(32, 32+64-1, 12, 32, 32+64-1), COBBLE)
    # outer = circle_y(0, 11, 0, 176 + 3, True)
    # inner = circle_y(0, 11, 0, 176 - 3, True)
    # set_blocks(outer - inner, STONE)
    # a = sphere(-32, 48, -32, 24, True)
    # b = sphere(-24, 40, -24, 24, True)
    # set_blocks(a - b, PLANK)
    # set_blocks(cylinder_x(-64, 64, 32, 0, 8), STONE)
    # data = [
    #     '...............................',
    #     '..xxx..xxxx...xxx..xxxxx.xxxxx.',
    #     '.x...x.x...x.x...x.x.......x...',
    #     '.x.....xxxx..xxxxx.xxx.....x...',
    #     '.x...x.x..x..x...x.x.......x...',
    #     '..xxx..x...x.x...x.x.......x...',
    #     '...............................',
    # ]
    # lookup = {
    #     'x': STONE,
    #     '.': PLANK,
    # }
    # client.bitmap(0, 32, 32, (1, 0, 0), (0, -1, 0), data, lookup)

if __name__ == '__main__':
    main()
