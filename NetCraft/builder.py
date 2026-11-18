"""Build a customizable CashToken winter park in a NEW Rust-server world.

Run before starting the server:

    mkdir -p data
    python3 NetCraft/builder.py --init-park data/netcraft.db

The database path must not already exist. The server then opens it normally;
this script does not change a running server or overwrite an existing world.
It requires a C compiler and the checked-in terrain sources so it can clear
only blocks that actually exist in the server's generated terrain.

Customize PARK_* below and the drawing functions in make_park(). Coordinates
are block coordinates, with (0, 0) at the player spawn. The calendar's 24
numbered panels are decorative, not interactive doors. Block IDs are the
same as NetCraft/src/item.h; the original shape helpers are also available.
Always test changes in a new world and back up any world you want to keep.
"""

import argparse
from contextlib import closing
import ctypes
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
LIGHT_STONE = 12
DARK_STONE = 13
CHEST = 14
LEAVES = 15
CLOUD = 16
TALL_GRASS = 17
YELLOW_FLOWER = 18
RED_FLOWER = 19
PURPLE_FLOWER = 20
SUN_FLOWER = 21
WHITE_FLOWER = 22
BLUE_FLOWER = 23
COLOR_WHITE = 32
COLOR_GOLD = 36
COLOR_GREEN = 45
COLOR_RED = 46

# Park footprint and layout; leave the spawn at (0, 0) unobstructed.
PARK_HALF_WIDTH = 28
PARK_Z_MIN = -25
PARK_Z_MAX = 28
CALENDAR_Z = -21
TREE_POSITIONS = [(-21, -11), (21, -11), (-21, 14), (21, 14)]

DIGITS = (
    ("111", "101", "101", "101", "111"),
    ("010", "110", "010", "010", "111"),
    ("111", "001", "111", "100", "111"),
    ("111", "001", "111", "001", "111"),
    ("101", "101", "111", "001", "001"),
    ("111", "100", "111", "001", "111"),
    ("111", "100", "111", "101", "111"),
    ("111", "001", "010", "010", "010"),
    ("111", "101", "111", "101", "111"),
    ("111", "101", "111", "001", "111"),
)

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
        for p in range(-PARK_HALF_WIDTH // 32, PARK_HALF_WIDTH // 32 + 1):
            for q in range(PARK_Z_MIN // 32, PARK_Z_MAX // 32 + 1):
                def collect(x, y, z, w, _):
                    if (x // 32 == p and z // 32 == q and
                            -PARK_HALF_WIDTH <= x <= PARK_HALF_WIDTH and
                            PARK_Z_MIN <= z <= PARK_Z_MAX and w > 0):
                        terrain[x, y, z] = w
                callback = callback_type(collect)
                generator.create_world(p, q, callback, None)
    return terrain

def make_park(terrain):
    """Return absolute block edits; the last drawing at a position wins."""
    # Keep the plaza at the natural spawn height so a new player lands on it.
    ground = [y for (x, y, z), w in terrain.items()
              if x == z == 0 and w in (GRASS, SAND, STONE, CEMENT, DIRT, SNOW, COBBLE)]
    if not ground:
        raise ValueError("Could not find natural ground at the park spawn")
    floor = max(ground)
    if not 31 <= floor <= 200:
        raise ValueError("Spawn ground is outside the supported park height")
    edits = {}

    def put(x, y, z, block):
        if not (-PARK_HALF_WIDTH <= x <= PARK_HALF_WIDTH and
                PARK_Z_MIN <= z <= PARK_Z_MAX and 1 <= y <= 255):
            raise ValueError("Park structure extends outside its footprint")
        edits[x, y, z] = block

    def box(x1, x2, y1, y2, z1, z2, block):
        for position in cuboid(x1, x2, y1, y2, z1, z2):
            put(*position, block)

    # Clear natural terrain, trees and clouds above the plaza.
    for (x, y, z), block in terrain.items():
        if floor < y <= 255:
            put(x, y, z, EMPTY)
    for x in range(-PARK_HALF_WIDTH, PARK_HALF_WIDTH + 1):
        for z in range(PARK_Z_MIN, PARK_Z_MAX + 1):
            # Support the plaza where natural terrain falls below the floor.
            for y in range(31, floor):
                if (x, y, z) not in terrain:
                    put(x, y, z, DIRT)
            path = abs(x) <= 3 or abs(z) <= 2
            put(x, floor, z, CEMENT if path else SNOW)

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

    # A freestanding six-by-four advent calendar. Panels have visible
    # two-digit numbers drawn in blocks; change DIGITS or colors to customize.
    box(-23, 23, floor + 1, floor + 35, CALENDAR_Z, CALENDAR_Z, PLANK)
    for row in range(4):
        for column in range(6):
            left = -21 + column * 7
            bottom = floor + 27 - row * 8
            box(left, left + 6, bottom, bottom + 7, CALENDAR_Z + 1, CALENDAR_Z + 1,
                COLOR_RED if (row + column) % 2 == 0 else COLOR_GREEN)
            number = "%02d" % (row * 6 + column + 1)
            for index, character in enumerate(number):
                for dy, pixels in enumerate(DIGITS[int(character)]):
                    for dx, pixel in enumerate(pixels):
                        if pixel == "1":
                            put(left + index * 4 + dx, bottom + 6 - dy,
                                CALENDAR_Z + 2, COLOR_WHITE)
    box(-24, 24, floor + 36, floor + 36, CALENDAR_Z, CALENDAR_Z, COLOR_GOLD)

    # A gold-rimmed CashToken-inspired coin with a block-letter B.
    cx, cz = 0, 20
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
    box(-1, 1, floor + 1, floor + 2, cz, cz, COBBLE)
    return edits

def initialize_park(path):
    """Create, but never replace, a database for the Rust server."""
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
            rows = []
            for (x, y, z), block in edits.items():
                p, q = x // 32, z // 32
                for dx in (-1, 0, 1):
                    for dz in (-1, 0, 1):
                        if dx and (x + dx) // 32 == p:
                            continue
                        if dz and (z + dz) // 32 == q:
                            continue
                        rows.append((p + dx, q + dz, x, y, z,
                                     block if dx == dz == 0 else -block))
            db.executemany("INSERT INTO block VALUES (?,?,?,?,?,?)", rows)
        completed = True
    finally:
        if not completed:
            os.unlink(path)
    print("Created %s with %d park edits. Start the server with this database." % (path, len(edits)))

def main():
    if any(arg in ('--init-park', '--help', '-h') for arg in sys.argv[1:]):
        parser = argparse.ArgumentParser(description=__doc__,
                                         formatter_class=argparse.RawDescriptionHelpFormatter)
        parser.add_argument('--init-park', required=True, metavar='NEW_DATABASE')
        args = parser.parse_args()
        initialize_park(args.init_park)
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
