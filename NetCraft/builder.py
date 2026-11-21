"""Build the CashToken sky park or apply modular terrain files offline.

Run before starting the server:

    python3 NetCraft/builder.py
    python3 NetCraft/builder.py --init-park data/netcraft.db
    python3 NetCraft/builder.py --add-park data/existing-world.db
    python3 NetCraft/builder.py --apply-terrain data/netcraft.db --terrain NetCraft/terrain/lookout.json

With no arguments, a new Compose world is created at data/netcraft.db. An
existing database is never replaced; use --add-park only after stopping the
server and backing up the world.
Stop the server before running either command. --init-park creates a new
database; --add-park requires an existing Rust-server world and preserves
existing block, light and sign edits, skipping park blocks at those positions.
Back up existing worlds before building.
The built-in park requires a C compiler to check its placement against
the server's generated terrain. JSON terrain files do not require a compiler.
Customize PARK_*, SKY_Y, TOWER_Z and the drawing functions in make_park().
Coordinates are absolute [x, y, z] world block coordinates.
Set DONATION_ADDRESS below to add a block-built donation QR (requires segno).
The seven gold spheres are decorative, not interactive. Block IDs match NetCraft/src/item.h;
the original shape helpers are also available. The natural world remains
outside the tower.
Always test changes in a new world and back up any world you want to keep.
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
SPHERE_POSITIONS = [(-58, -4), (-58, 4), (58, -4), (58, 4),
                    (-5, -58), (5, -58), (-5, 58)]
ISLAND_DIRECTIONS = (("x", -1), ("x", 1), ("z", -1), ("z", 1))
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

def make_park(terrain):
    """Return absolute block edits; the last drawing at a position wins."""
    ground = [y for (x, y, z), w in terrain.items()
              if x == 0 and z == TOWER_Z and w in (GRASS, SAND, STONE, CEMENT, DIRT, SNOW, COBBLE, 83)]
    if not ground:
        raise ValueError("Could not find natural ground below the sky park tower")
    base = max(ground)
    floor = SKY_Y
    if not 31 <= base < floor - 14 or floor + 46 > 255:
        raise ValueError("Tower and park do not fit between spawn and world height limit")
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

    draw_dragon(put, box, floor)

    # Four floating gardens linked to the central park.
    for axis, side in ISLAND_DIRECTIONS:
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
        draw_bridge(put, floor, axis, side, start, 43)
        for dx in (-3, 3):
            for dz in (-3, 3):
                box(cx + dx, cx + dx, floor + 1, floor + 5, cz + dz, cz + dz, WOOD)
        box(cx - 4, cx + 4, floor + 6, floor + 6, cz - 4, cz + 4, PLANK)
        box(cx - 3, cx + 3, floor + 7, floor + 7, cz - 3, cz + 3, COLOR_RED)
        put(cx, floor + 8, cz, COLOR_GOLD)
        draw_tree(put, box, floor, cx + 6, cz + 5)
        wx, wz = (cx + side * 9, cz) if axis == "x" else (cx, cz + side * 9)
        box(wx, wx, floor - 18, floor - 1, wz, wz, WATER)

    draw_outer_islands(put, box, floor)
    for gx, gz in SPHERE_POSITIONS:
        for point in sphere(gx, floor + 5, gz, 3, fill=True):
            put(*point, COLOR_GOLD)
    for point in edits:
        if point[1] >= floor - 32 and terrain.get(point, EMPTY) not in (EMPTY, CLOUD):
            raise ValueError(f"Sky park intersects natural terrain at {point}; raise SKY_Y")
    return edits


def draw_dragon(put, box, floor):
    # Layer the new silhouette over the original footprint so old park saves get the added details too.
    for x in range(-22, 24):
        y = floor + 25 + round(2 * math.sin(x / 7))
        radius = 4 if x < 12 else 3
        for point in sphere(x, y, 0, radius, fill=True):
            _, py, pz = point
            color = COLOR_GREEN
            if py <= y - radius + 1:
                color = COLOR_GOLD
            elif abs(pz) >= radius - 1 and (x + py) % 5 < 2:
                color = COLOR_CYAN
            put(*point, color)
    for x in range(-20, 24, 4):
        y = floor + 25 + round(2 * math.sin(x / 7)) + (4 if x < 12 else 3)
        for rise in range(4):
            put(x - rise // 2, y + rise, 0, COLOR_GOLD)
    box(-27, -21, floor + 23, floor + 29, -4, 4, COLOR_GREEN)
    box(-31, -27, floor + 22, floor + 25, -3, 3, COLOR_GREEN)
    box(-35, -29, floor + 24, floor + 26, -3, 3, COLOR_GREEN)
    box(-34, -29, floor + 20, floor + 21, -2, 2, COLOR_CYAN)
    for side in (-1, 1):
        z = side * 5
        box(-29, -25, floor + 27, floor + 28, z, z, COLOR_GREEN)
        put(-28, floor + 27, z, COLOR_GOLD)
        put(-27, floor + 27, z, COLOR_BLACK)
        put(-26, floor + 27, z, COLOR_GOLD)
        put(-34, floor + 26, side * 3, COLOR_BLACK)
        for x in (-33, -31, -29):
            put(x, floor + 23, side * 3, COLOR_WHITE)
        for rise in range(8):
            put(-24 + rise // 2, floor + 30 + rise, side * (3 + rise // 3), COLOR_GOLD)
            if rise < 5:
                put(-23 + rise // 2, floor + 30 + rise, side * (3 + rise // 3), COLOR_GOLD)
    for side in (-1, 1):
        span = 30 if side < 0 else 22  # Keep clear of the donation QR to the south.
        for distance in range(3, span + 1):
            tip = (distance - 3) / (span - 3)
            leading = round(-12 + 18 * tip**2)
            trailing = round(13 + 9 * tip - 12 * tip**4 - (distance % 6) * tip / 2)
            for x in range(leading, trailing + 1):
                y = floor + 28 + distance // 3 + (x - leading) // 8
                rib = x in (leading, trailing) or abs(x - round(1 + 10 * tip)) <= 1
                put(x, y, side * distance, COLOR_GOLD if rib else COLOR_CYAN)
                put(x, y - 1, side * distance, COLOR_GREEN if rib else COLOR_CYAN)
        for x in (-12, 10):
            for step in range(6):
                put(x + step // 2, floor + 23 - step, side * (2 + step // 2), COLOR_GREEN)
            for toe in (-1, 0, 1):
                put(x + 1, floor + 17, side * 4 + toe, COLOR_WHITE)
    for x in range(23, 43):
        y = floor + 24 - round(5 * math.sin((x - 23) / 8))
        z = round(7 * math.sin((x - 23) / 9))
        for point in sphere(x, y, z, 3 if x < 29 else 2 if x < 37 else 1, fill=True):
            put(*point, COLOR_GREEN)
        if x < 35:  # Retain the old tail inside the wider silhouette on an upgrade.
            put(x, floor + 24 - (x - 24) // 2, 0, COLOR_GREEN)
    for x in range(39, 45):
        for z in range(4 - (x - 39) // 2, 9 + (x - 39) // 2):
            put(x, floor + 21 + (x - 39) // 2, z, COLOR_GOLD if x == 44 else COLOR_CYAN)


def draw_bridge(put, floor, axis, side, first, last, detailed=False):
    for distance in range(first, last + 1):
        for offset in range(-2, 3):
            x, z = (side * distance, offset) if axis == "x" else (offset, side * distance)
            put(x, floor, z, CEMENT if detailed and abs(offset) == 2 else PLANK)
            edge = abs(offset) == 2
            put(x, floor + 1, z,
                COLOR_WHITE if edge and distance % 3 == 0 else PLANK if edge and detailed else EMPTY)
            if detailed and edge and distance % 8 == 0:
                put(x, floor + 2, z, COLOR_GOLD)
                put(x, floor - 1, z, COBBLE)


def draw_tree(put, box, floor, x, z):
    box(x, x, floor + 1, floor + 6, z, z, WOOD)
    for dx in range(-2, 3):
        for dz in range(-2, 3):
            for dy in range(4, 8):
                if abs(dx) + abs(dz) + abs(dy - 5) <= 4 and (dx or dz):
                    put(x + dx, floor + dy, z + dz, LEAVES)


def draw_outer_islands(put, box, floor):
    for axis, side in ISLAND_DIRECTIONS:
        cx, cz = (side * OUTER_ISLAND_DISTANCE, 0) if axis == "x" else (0, side * OUTER_ISLAND_DISTANCE)
        for dx in range(-16, 17):
            for dz in range(-16, 17):
                radius = math.hypot(dx, dz)
                edge = 15 + math.sin(dx * .7 + dz * .4) + .5 * math.cos(dz * .8)
                if radius > edge:
                    continue
                path = abs(dz if axis == "x" else dx) <= 1
                put(cx + dx, floor, cz + dz, CEMENT if path else GRASS)
                depth = min(13, round((edge - radius) * .8))
                for down in range(1, depth + 1):
                    block = DIRT if down <= 2 else (
                        COLOR_CYAN if down > 7 and (dx * 13 + dz * 7 + down) % 23 == 0 else COBBLE)
                    put(cx + dx, floor - down, cz + dz, block)
                if not path and radius < 14 and (dx * 13 + dz * 7) % 23 == 1:
                    put(cx + dx, floor + 1, cz + dz, YELLOW_FLOWER if dx % 2 else RED_FLOWER)
        draw_bridge(put, floor, axis, side, 64, OUTER_ISLAND_DISTANCE - 10, detailed=True)
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
            box(cx - 3, cx + 3, floor + 1, floor + 1, cz - 3, cz + 3, PLANK)

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


def initialize_park(path, extra=None):
    """Create, but never replace, a database for the Rust server."""
    if Path(path).exists():
        raise FileExistsError("World already exists; back it up and use --add-park with the server stopped")
    terrain = terrain_in_park()
    edits = make_park(terrain)
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


def apply_world_edits(path, edits):
    """Atomically insert unoccupied coordinates, including their chunk-border copies."""
    with closing(sqlite3.connect(Path(path).resolve().as_uri() + "?mode=rw", uri=True, timeout=10)) as db:
        with db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("CREATE TEMP TABLE requested (p INTEGER, q INTEGER, x INTEGER, y INTEGER, z INTEGER, w INTEGER)")
            db.executemany("INSERT INTO requested VALUES (?,?,?,?,?,?)", park_rows(edits))
            optional = {row[0] for row in db.execute(
                "SELECT name FROM sqlite_schema WHERE type='table' AND name IN ('light', 'sign')")}
            occupied = set()
            for table in ("block", "light", "sign"):
                if table != "block" and table not in optional:
                    continue
                columns = ("x", "y", "z") if table == "sign" else ("p", "q", "x", "y", "z")
                clause = " AND ".join(f"entry.{key}=r.{key}" for key in columns)
                occupied.update(db.execute(f"""
                    SELECT DISTINCT r.x,r.y,r.z FROM requested AS r
                    WHERE EXISTS (SELECT 1 FROM {table} AS entry WHERE {clause})
                """))
            accepted = len(edits) - len(occupied)
            db.executemany("INSERT INTO block (p,q,x,y,z,w) VALUES (?,?,?,?,?,?)",
                           park_rows({pos: block for pos, block in edits.items() if pos not in occupied}))
    print("Added %d world edits to %s; preserved %d overlapping positions. Restart the server." %
          (accepted, path, len(occupied)))


def add_park(path, extra=None):
    """Add the built-in park, optionally layered with terrain modules."""
    edits = make_park(terrain_in_park())
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
    parser.add_argument('--terrain', action='append', default=[], metavar='FILE',
                        help='load a JSON terrain module; repeat to layer multiple files')
    args = parser.parse_args()
    if args.apply_terrain and not args.terrain:
        parser.error("--apply-terrain requires at least one --terrain file")
    if args.legacy_client and args.terrain:
        parser.error("--terrain cannot be used with --legacy-client")
    if not args.legacy_client:
        try:
            extra = load_terrain_files(args.terrain)
            if args.apply_terrain:
                apply_world_edits(args.apply_terrain, extra)
            elif args.add_park:
                add_park(args.add_park, extra)
            else:
                path = Path(args.init_park) if args.init_park else Path(__file__).resolve().parent.parent / "data" / "netcraft.db"
                if not args.init_park:
                    path.parent.mkdir(parents=True, exist_ok=True)
                initialize_park(path, extra)
        except (OSError, ValueError, sqlite3.Error) as exc:
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
