"""Build the CashToken sky park or apply modular terrain files offline.

Run before starting the server:

    python3 NetCraft/builder.py
    python3 NetCraft/builder.py --init-park data/netcraft.db
    python3 NetCraft/builder.py --add-park data/existing-world.db --park-module dragon
    python3 NetCraft/builder.py --apply-terrain data/netcraft.db --terrain NetCraft/terrain/lookout.json

With no arguments, a new Compose world is created at data/netcraft.db.
Use a fresh database for the full layout; --add-park does not remove old builds.
Back up existing worlds and stop the server before editing them. By default
saved blocks, lights and signs are preserved. For targeted changes to saved
blocks, use --apply-terrain with --replace-blocks and reviewed JSON modules.
Repeat --park-module to build only selected features from the built-in park.
Selections do not add dependencies: orbs sit on the gardens, and bridges
connect the plaza, gardens, landmarks and terraces.
Building park modules requires a C compiler; applying JSON terrain does not.
Coordinates are [x, y, z]. Block IDs match NetCraft/src/item.h.
"""

import argparse
from contextlib import closing
import ctypes
import json
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
WORLD_HALF_WIDTH = 124
WORLD_Z_MIN = -124
WORLD_Z_MAX = 124
SKY_Y = 180
OUTER_ISLAND_DISTANCE = 108
TOWER_Z = -12
DONATION_ADDRESS = ""  # Set a Bitcoin Cash donation address before building the QR.
DONATION_QR_Z = 24
TREE_POSITIONS = [(-21, -11), (21, -11), (-21, 14), (21, 14)]
ISLAND_DIRECTIONS = (("x", -1), ("x", 1), ("z", -1), ("z", 1))
CORNER_SIGNS = ((-1, -1), (-1, 1), (1, -1), (1, 1))
GARDEN_DISTANCE = 53
# Each orb faces the walking path along the given axis.
ORB_DISPLAYS = ((-56, -7, "x"), (-56, 7, "x"), (56, -7, "x"), (56, 7, "x"),
                (-7, -56, "z"), (7, -56, "z"), (-7, 56, "z"))
MAX_COORD = 262_000
MAX_TERRAIN_BLOCKS = 250_000
MAX_TERRAIN_BYTES = 8 * 1024 * 1024
TERRAIN_BLOCK_IDS = set(range(24)) | set(range(32, 68)) | {70, 73, 83}

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
                    if (y >= SKY_Y - 32 or (x == 0 and z == TOWER_Z)) and (
                            x // 32 == p and z // 32 == q and
                            -WORLD_HALF_WIDTH <= x <= WORLD_HALF_WIDTH and
                            WORLD_Z_MIN <= z <= WORLD_Z_MAX and w > 0):
                        terrain[x, y, z] = w
                callback = callback_type(collect)
                generator.create_world(p, q, callback, None)
    return terrain

def make_park(terrain, modules=None):
    """Return absolute block edits; the last drawing at a position wins."""
    floor = SKY_Y
    selected = PARK_MODULES.keys() if modules is None else set(modules)
    unknown = selected - PARK_MODULES.keys()
    if unknown:
        raise ValueError(f"Unknown park modules: {', '.join(sorted(unknown))}")
    edits = {}

    def put(x, y, z, block):
        if not (-WORLD_HALF_WIDTH <= x <= WORLD_HALF_WIDTH and
                WORLD_Z_MIN <= z <= WORLD_Z_MAX and 1 <= y <= 255):
            raise ValueError("Park structure extends outside its footprint")
        edits[x, y, z] = block

    def box(x1, x2, y1, y2, z1, z2, block):
        for position in cuboid(x1, x2, y1, y2, z1, z2):
            put(*position, block)

    for name, draw in PARK_MODULES.items():
        if name in selected:
            if name == "plaza":
                draw(put, box, floor, terrain)
            else:
                draw(put, box, floor)
    for point in edits:
        if point[1] >= floor - 32 and terrain.get(point, EMPTY) not in (EMPTY, CLOUD):
            raise ValueError(f"Sky park intersects natural terrain at {point}; raise SKY_Y")
    return edits


def draw_plaza(put, box, floor, terrain):
    ground = [y for (x, y, z), w in terrain.items()
              if x == 0 and z == TOWER_Z and w in (GRASS, SAND, STONE, CEMENT, DIRT, SNOW, COBBLE, 83)]
    if not ground:
        raise ValueError("Could not find natural ground below the sky park tower")
    base = max(ground)
    if not 31 <= base < floor - 14:
        raise ValueError("Tower does not fit between spawn and the plaza")

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


def draw_gardens(put, box, floor):
    for axis, side in ISLAND_DIRECTIONS:
        cx, cz = (side * GARDEN_DISTANCE, 0) if axis == "x" else (0, side * GARDEN_DISTANCE)
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
                if distance < 25 and (dx * 17 + dz * 13) % 13 == 1:
                    put(cx + dx, floor + 1, cz + dz, YELLOW_FLOWER)
        for dx in (-2, 2):
            for dz in (-2, 2):
                box(cx + dx, cx + dx, floor + 1, floor + 5, cz + dz, cz + dz, WOOD)
        box(cx - 2, cx + 2, floor + 6, floor + 6, cz - 2, cz + 2, PLANK)
        box(cx - 2, cx + 2, floor + 7, floor + 7, cz - 2, cz + 2, COLOR_RED)
        put(cx, floor + 8, cz, COLOR_GOLD)
        draw_tree(put, box, floor, cx - side * 6 if axis == "x" else cx + 5,
                  cz + 5 if axis == "x" else cz - side * 6)
        wx, wz = (cx + side * 9, cz) if axis == "x" else (cx, cz + side * 9)
        box(wx, wx, floor - 18, floor - 1, wz, wz, WATER)


def ellipsoid(cx, cy, cz, rx, ry, rz):
    for dx in range(-rx, rx + 1):
        for dy in range(-ry, ry + 1):
            for dz in range(-rz, rz + 1):
                if (dx / rx)**2 + (dy / ry)**2 + (dz / rz)**2 <= 1:
                    yield cx + dx, cy + dy, cz + dz


def draw_dragon(put, box, floor):
    """A blue storm dragon with a sweeping spine, feathered fins and a plated belly."""
    head, tail = -94, 108

    def spine(x):
        return (floor + 46 + round(12 * math.cos((x - 12) / 40)),
                round(36 * math.sin((x + 14) / 30)))

    for x in range(head, tail + 1):
        y, z = spine(x)
        radius = max(2, min(8, (tail + 14 - x) // 12))
        for dy in range(-radius, radius + 1):
            width = math.isqrt(radius**2 - dy**2)
            for dz in range(-width, width + 1):
                if dy <= -radius + 2:
                    block = COLOR_WHITE if x % 7 == 0 else COLOR_GOLD
                elif abs(dz) >= width - 1 and (x + 2 * (dy % 3)) % 7 < 2:
                    block = COLOR_CYAN
                else:
                    block = COLOR_BLUE
                put(x, y + dy, z + dz, block)
        if (x - head) % 5 < 3 and x < tail - 12:
            for rise in range(1, min(7, radius + 2)):
                for dz in range(-1, 2):
                    put(x, y + radius + rise, z + dz,
                        COLOR_WHITE if rise >= 5 else COLOR_PURPLE)

    y, z = spine(head)
    for x, py, pz in ellipsoid(head - 3, y + 1, z, 12, 9, 10):
        put(x, py, pz, COLOR_PURPLE if py >= y + 6 else COLOR_BLUE)
    for x, py, pz in ellipsoid(head - 13, y - 2, z, 9, 5, 7):
        put(x, py, pz, COLOR_CYAN if py >= y - 2 else COLOR_BLUE)
    for side in (-1, 1):
        # Eye sockets, nostrils, and backward-swept crest blades.
        box(head - 10, head - 5, y + 2, y + 5, z + side * 7, z + side * 10, COLOR_PURPLE)
        box(head - 9, head - 6, y + 3, y + 4, z + side * 10, z + side * 10, COLOR_WHITE)
        put(head - 8, y + 3, z + side * 11, COLOR_BLACK)
        put(head - 18, y + 1, z + side * 4, COLOR_BLACK)
        for step in range(14):
            cx, cy, cz = head - 6 + step, y + 7 + step // 2, z + side * (5 + step // 2)
            box(cx, cx, cy - 1, cy + 1, cz, cz + side, COLOR_WHITE if step > 7 else COLOR_PURPLE)

    for root, span in ((-61, 31), (60, 24), (100, 11)):
        for side in (-1, 1):
            for feather in range(5):
                length = span - feather * 3
                if length < 3:
                    break
                start = root + feather * 3
                y, z = spine(start)
                for step in range(length + 1):
                    x = start + step // 2
                    py = y - 1 + step // 4
                    pz = z + side * step
                    box(x, x + (2 if step < length - 2 else 1), py - 1, py, pz, pz,
                        COLOR_WHITE if step >= length - 2 else COLOR_CYAN if feather % 2 else COLOR_PURPLE)


ORB_PIPS = {
    1: ((0, 0),),
    2: ((-2, 2), (2, -2)),
    3: ((-2, 2), (0, 0), (2, -2)),
    4: ((-2, 2), (2, 2), (-2, -2), (2, -2)),
    5: ((-2, 2), (2, 2), (-2, -2), (2, -2), (0, 0)),
    6: ((-2, 3), (2, 3), (-2, 0), (2, 0), (-2, -3), (2, -3)),
    7: ((-2, 3), (2, 3), (-3, 0), (0, 0), (3, 0), (-2, -3), (2, -3)),
}


def draw_orbs(put, box, floor):
    for number, (x, z, axis) in enumerate(ORB_DISPLAYS, 1):
        y = floor + 7
        box(x - 2, x + 2, floor + 1, floor + 1, z - 2, z + 2, COLOR_WHITE)
        box(x - 1, x + 1, floor + 2, floor + 2, z - 1, z + 1, COBBLE)
        for px, py, pz in ellipsoid(x, y, z, 5, 5, 5):
            put(px, py, pz, COLOR_WHITE if py > y + 3 else COLOR_GOLD)
        # Project each five-pixel star onto both curved faces of the orb.
        for u, v in ORB_PIPS[number]:
            for du, dv in ((0, 0), (0, 1), (0, -1), (1, 0), (-1, 0)):
                a, b = u + du, v + dv
                depth = math.isqrt(25 - a*a - b*b)
                for side in (-1, 1):
                    dx, dz = (side * depth, a) if axis == "x" else (a, side * depth)
                    put(x + dx, y + b, z + dz, COLOR_RED)


def draw_bridge(put, floor, axis, first, last, lane=0):
    for distance in range(min(first, last), max(first, last) + 1):
        for offset in range(-2, 3):
            x, z = (distance, lane + offset) if axis == "x" else (lane + offset, distance)
            edge = abs(offset) == 2
            put(x, floor, z, CEMENT if edge else PLANK)
            put(x, floor + 1, z, PLANK if edge else EMPTY)
            if edge and distance % 8 == 0:
                put(x, floor + 2, z, COLOR_GOLD)
                put(x, floor - 1, z, COBBLE)


def draw_bridges(put, _box, floor):
    outer = OUTER_ISLAND_DISTANCE
    for axis, side in ISLAND_DIRECTIONS:
        plaza_edge = PARK_HALF_WIDTH if axis == "x" else (PARK_Z_MAX if side > 0 else -PARK_Z_MIN)
        draw_bridge(put, floor, axis, side * plaza_edge, side * (GARDEN_DISTANCE - 9))
        draw_bridge(put, floor, axis, side * (GARDEN_DISTANCE + 9), side * (outer - 12))
        for lane_side in (-1, 1):
            draw_bridge(put, floor, axis, lane_side * 12, lane_side * (outer - 12), side * outer)


def draw_tree(put, box, floor, x, z):
    box(x, x, floor + 1, floor + 6, z, z, WOOD)
    for dx in range(-2, 3):
        for dz in range(-2, 3):
            for dy in range(4, 8):
                if abs(dx) + abs(dz) + abs(dy - 5) <= 4 and (dx or dz):
                    put(x + dx, floor + dy, z + dz, LEAVES)


def draw_rock_island(put, floor, cx, cz):
    for dx in range(-16, 17):
        for dz in range(-16, 17):
            radius = math.hypot(dx, dz)
            edge = 15 + math.sin(dx * .7 + dz * .4) + .5 * math.cos(dz * .8)
            if radius > edge:
                continue
            path = min(abs(dx), abs(dz)) <= 1
            put(cx + dx, floor, cz + dz, CEMENT if path else GRASS)
            depth = min(13, round((edge - radius) * .8))
            for down in range(1, depth + 1):
                block = DIRT if down <= 2 else (
                    COLOR_CYAN if down > 7 and (dx * 13 + dz * 7 + down) % 23 == 0 else COBBLE)
                put(cx + dx, floor - down, cz + dz, block)
            if not path and radius < 14 and (dx * 13 + dz * 7) % 23 == 1:
                put(cx + dx, floor + 1, cz + dz, YELLOW_FLOWER if dx % 2 else RED_FLOWER)


def draw_terraces(put, box, floor):
    for sx, sz in CORNER_SIGNS:
        cx, cz = sx * OUTER_ISLAND_DISTANCE, sz * OUTER_ISLAND_DISTANCE
        draw_rock_island(put, floor, cx, cz)
        for dx, dz in ((-6, -6), (-6, 6), (6, -6), (6, 6)):
            draw_tree(put, box, floor, cx + dx, cz + dz)
        for side in (-1, 1):
            box(cx - 3, cx + 3, floor + 1, floor + 1, cz + side * 4, cz + side * 4, COLOR_WHITE)
            put(cx + 3 * side, floor + 2, cz + side * 4, COLOR_GOLD)


def draw_outer_islands(put, box, floor):
    for axis, side in ISLAND_DIRECTIONS:
        cx, cz = (side * OUTER_ISLAND_DISTANCE, 0) if axis == "x" else (0, side * OUTER_ISLAND_DISTANCE)
        draw_rock_island(put, floor, cx, cz)
        if axis == "z" and side < 0:  # Observatory
            for dx in (-5, 5):
                for dz in (-5, 5):
                    box(cx + dx, cx + dx, floor + 1, floor + 7, cz + dz, cz + dz, COLOR_WHITE)
            for x, y, z in sphere(cx, floor + 7, cz, 8):
                if y >= floor + 7:
                    put(x, y, z, COLOR_BLUE if (x - cx) % 4 == 0 else GLASS)
            put(cx, floor + 16, cz, COLOR_GOLD)
        elif axis == "z":  # Lagoon, with a spillway below the edge.
            for dx in range(-6, 7):
                for dz in range(-4, 5):
                    if dx * dx + dz * dz <= 36:
                        put(cx + dx, floor, cz + dz + 5, WATER)
                        put(cx + dx, floor - 1, cz + dz + 5, COLOR_BLUE)
            box(cx - 1, cx + 1, floor, floor, cz + 9, cz + 15, WATER)
            box(cx - 1, cx + 1, floor - 24, floor - 1, cz + 15, cz + 15, WATER)
        elif side > 0:  # Ruined arches over the approach.
            for dx in (-4, 3, 9):
                for dz in (-4, 4):
                    box(cx + dx, cx + dx, floor + 1, floor + 5, cz + dz, cz + dz, COBBLE)
                box(cx + dx, cx + dx, floor + 6, floor + 6, cz - 3, cz + 3, COBBLE)
                put(cx + dx, floor + 7, cz, COLOR_GOLD)
        else:  # Grove
            for dx, dz in ((-6, -5), (-6, 5), (2, -7), (7, 6)):
                draw_tree(put, box, floor, cx + dx, cz + dz)
            box(cx - 3, cx + 3, floor, floor, cz - 3, cz + 3, PLANK)


# Bridges are layered after island terrain so their openings clear rails and plants.
PARK_MODULES = {
    "plaza": draw_plaza,
    "gardens": draw_gardens,
    "landmarks": draw_outer_islands,
    "terraces": draw_terraces,
    "bridges": draw_bridges,
    "dragon": draw_dragon,
    "orbs": draw_orbs,
}

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


def load_terrain_files(paths):
    """Expand versioned JSON modules in command-line order, without touching a world."""
    edits = {}
    expanded = 0

    def vector(value, label):
        if not isinstance(value, list) or len(value) != 3 or any(type(n) is not int for n in value):
            raise ValueError(f"{label} must be an [x, y, z] integer vector")
        return value

    for path in paths:
        try:
            with Path(path).open("rb") as source:
                payload = source.read(MAX_TERRAIN_BYTES + 1)
            if len(payload) > MAX_TERRAIN_BYTES:
                raise ValueError("terrain file exceeds 8 MiB")
            module = json.loads(payload)
            if (not isinstance(module, dict) or set(module) - {"version", "origin", "edits"} or
                    type(module.get("version")) is not int or module["version"] != 1 or
                    not isinstance(module.get("edits"), list) or not module["edits"]):
                raise ValueError("expected a version 1 terrain module with a nonempty edits list")
            origin = vector(module.get("origin", [0, 0, 0]), "origin")

            def position(value):
                x, y, z = (real + offset for real, offset in zip(vector(value, "coordinate"), origin))
                if abs(x) > MAX_COORD or abs(z) > MAX_COORD or not -26 <= y <= 255:
                    raise ValueError(f"coordinate ({x}, {y}, {z}) is outside the world")
                return x, y, z

            for index, edit in enumerate(module["edits"], 1):
                try:
                    if not isinstance(edit, dict):
                        raise ValueError("expected an edit object")
                    block = edit.get("block")
                    if type(block) is not int or block not in TERRAIN_BLOCK_IDS:
                        raise ValueError("block must be a recognized NetCraft block ID (0 clears a block)")
                    if set(edit) == {"at", "block"}:
                        low = high = position(edit["at"])
                    elif set(edit) == {"from", "to", "block"}:
                        start, end = position(edit["from"]), position(edit["to"])
                        low = tuple(map(min, zip(start, end)))
                        high = tuple(map(max, zip(start, end)))
                    else:
                        raise ValueError("expected either at/block or from/to/block")
                    expanded += math.prod(b - a + 1 for a, b in zip(low, high))
                    if expanded > MAX_TERRAIN_BLOCKS:
                        raise ValueError(f"terrain files exceed {MAX_TERRAIN_BLOCKS:,} block edits")
                    edits.update((point, block) for point in cuboid(
                        low[0], high[0], low[1], high[1], low[2], high[2]))
                except ValueError as exc:
                    raise ValueError(f"edit {index}: {exc}") from exc
        except (OSError, ValueError, RecursionError) as exc:
            raise ValueError(f"{path}: {exc}") from exc
    return edits


def initialize_park(path, extra=None, modules=None):
    """Create, but never replace, a database for the Rust server."""
    if Path(path).exists():
        raise FileExistsError("World already exists; back it up and use --add-park with the server stopped")
    terrain = terrain_in_park()
    edits = make_park(terrain, modules)
    if extra:
        edits.update(extra)
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
    print("Created %s with %d world edits. Start the server with this database." % (path, len(edits)))


def apply_world_edits(path, edits, *, replace_blocks=False):
    """Atomically apply edits and their border copies, preserving signs and lights."""
    with closing(sqlite3.connect(Path(path).resolve().as_uri() + "?mode=rw", uri=True, timeout=10)) as db:
        with db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("CREATE TEMP TABLE requested (p INTEGER, q INTEGER, x INTEGER, y INTEGER, z INTEGER, w INTEGER)")
            db.executemany("INSERT INTO requested VALUES (?,?,?,?,?,?)", park_rows(edits))
            optional = {row[0] for row in db.execute(
                "SELECT name FROM sqlite_schema WHERE type='table' AND name IN ('light', 'sign')")}
            protected = set()
            for table in sorted(optional | ({"block"} if not replace_blocks else set())):
                columns = ("x", "y", "z") if table == "sign" else ("p", "q", "x", "y", "z")
                clause = " AND ".join(f"entry.{key}=r.{key}" for key in columns)
                protected.update(db.execute(f"""
                    SELECT DISTINCT r.x,r.y,r.z FROM requested AS r
                    WHERE EXISTS (SELECT 1 FROM {table} AS entry WHERE {clause})
                """))
            insert = "INSERT INTO block (p,q,x,y,z,w) VALUES (?,?,?,?,?,?)"
            if replace_blocks:
                insert += " ON CONFLICT(p,q,x,y,z) DO UPDATE SET w=excluded.w"
            db.executemany(insert, park_rows({
                pos: block for pos, block in edits.items() if pos not in protected
            }))
    print("Applied %d world edits to %s; preserved %d protected positions. Restart the server." %
          (len(edits) - len(protected), path, len(protected)))


def add_park(path, extra=None, modules=None):
    """Add the built-in park, optionally layered with terrain modules."""
    edits = make_park(terrain_in_park(), modules)
    if extra:
        edits.update(extra)
    apply_world_edits(path, edits)

def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    group = parser.add_mutually_exclusive_group()
    group.add_argument('--init-park', metavar='NEW_DATABASE')
    group.add_argument('--add-park', metavar='EXISTING_DATABASE')
    group.add_argument('--apply-terrain', metavar='EXISTING_DATABASE', help='apply modules without adding the park')
    group.add_argument('--legacy-client', action='store_true',
                       help='run the original network builder instead')
    parser.add_argument('--park-module', action='append', choices=PARK_MODULES,
                        help='build only this built-in module; repeat to select more')
    parser.add_argument('--terrain', action='append', default=[], metavar='FILE',
                        help='load a JSON terrain module; repeat to layer multiple files')
    parser.add_argument('--replace-blocks', action='store_true',
                        help='with --apply-terrain, replace saved blocks at module coordinates')
    args = parser.parse_args()
    if args.apply_terrain and not args.terrain:
        parser.error("--apply-terrain requires at least one --terrain file")
    if args.legacy_client and args.terrain:
        parser.error("--terrain cannot be used with --legacy-client")
    if args.park_module and (args.apply_terrain or args.legacy_client):
        parser.error("--park-module requires a park build")
    if args.replace_blocks and not args.apply_terrain:
        parser.error("--replace-blocks requires --apply-terrain")
    if not args.legacy_client:
        try:
            extra = load_terrain_files(args.terrain)
            if args.apply_terrain:
                apply_world_edits(args.apply_terrain, extra, replace_blocks=args.replace_blocks)
            elif args.add_park:
                add_park(args.add_park, extra, args.park_module)
            else:
                path = Path(args.init_park) if args.init_park else Path(__file__).resolve().parent.parent / "data" / "netcraft.db"
                if not args.init_park:
                    path.parent.mkdir(parents=True, exist_ok=True)
                initialize_park(path, extra, args.park_module)
        except (OSError, ValueError, sqlite3.Error, subprocess.CalledProcessError) as exc:
            parser.exit(1, f"{parser.prog}: {exc}\n")
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
