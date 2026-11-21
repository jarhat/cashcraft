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
It requires a C compiler and the checked-in terrain sources to check that
the islands fit above generated terrain.

Customize PARK_*, SKY_Y, TOWER_Z and the drawing functions in make_park().
Coordinates are block coordinates, with (0, 0) at the player spawn. The
central park connects to four floating garden islands by bridges. A single
pillar marks the route up; double-tap the keyboard jump key to fly.
Set DONATION_ADDRESS below to add a block-built donation QR (requires segno).
The seven amber sunstones are decorative, not interactive. Block IDs match NetCraft/src/item.h;
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

PARK_HALF_WIDTH = 52
PARK_HALF_LENGTH = 48
GARDEN_DISTANCE = 92
WORLD_HALF_WIDTH = 120
WORLD_Z_MIN = -120
WORLD_Z_MAX = 120
SKY_Y = 180
TOWER_Z = -12
DONATION_ADDRESS = ""  # Set a Bitcoin Cash donation address before building the QR.
DONATION_QR_Z = 24
TREE_POSITIONS = [(-31, -21), (33, -19), (-20, 32), (18, 33),
                  (-34, 12), (35, 13), (-17, -34), (19, -35)]
SPHERE_POSITIONS = [(-92, -11), (-92, 11), (92, -11), (92, 11),
                    (-11, -92), (11, -92), (11, 92)]
ORB_HEIGHT = 10
ORB_RADIUS = 6
CLIFF_DEPTH = 62
MAIN_WATER_DROP = 76

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
    """Sample spawn and sky-park elevations with the server's C generator."""
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
        for p in range((-WORLD_HALF_WIDTH) // 32, WORLD_HALF_WIDTH // 32 + 1):
            for q in range(WORLD_Z_MIN // 32, WORLD_Z_MAX // 32 + 1):
                def collect(x, y, z, w, _):
                    if (x // 32 == p and z // 32 == q and
                            -WORLD_HALF_WIDTH <= x <= WORLD_HALF_WIDTH and
                            WORLD_Z_MIN <= z <= WORLD_Z_MAX and w > 0 and
                            (x == z == 0 or y >= SKY_Y - MAIN_WATER_DROP)):
                        terrain[x, y, z] = w
                callback = callback_type(collect)
                generator.create_world(p, q, callback, None)
    return terrain


def build_dragon(put, floor):
    """Sculpt the park's original winged dragon from a curved, tapered body."""
    def dot(point, radius, block):
        x, y, z = point
        for px, py, pz in sphere(x, y, z, radius, fill=True):
            put(px, floor + py, pz, block)

    def stroke(a, b, block, radius=1):
        steps = max(abs(v - u) for u, v in zip(a, b))
        for i in range(steps + 1):
            point = tuple(round(u + (v - u) * i / max(steps, 1)) for u, v in zip(a, b))
            dot(point, radius, block)

    # The wings are voxelized triangular sails sharing spars at the shoulders.
    for side in (-1, 1):
        root = (-25, 38, -40)
        elbow = (-18, 52, -40 + 22 * side)
        tip = (10, 59, -40 + 49 * side)
        scallop = (4, 49, -40 + 30 * side)
        edge = (20, 47, -40 + 21 * side)
        heel = (3, 35, -40 + 3 * side)
        membrane = {}
        for a, b, c in ((root, elbow, scallop), (elbow, tip, scallop),
                        (root, scallop, edge), (root, edge, heel)):
            ax, ay, az = a
            bx, by, bz = b
            cx, cy, cz = c
            area = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz)
            for x in range(min(ax, bx, cx), max(ax, bx, cx) + 1):
                for z in range(min(az, bz, cz), max(az, bz, cz) + 1):
                    u = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / area
                    v = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / area
                    w = 1 - u - v
                    if min(u, v, w) >= -1e-9:
                        membrane[x, z] = (round(u * ay + v * by + w * cy),
                                          COLOR_CYAN if u + v < .65 else COLOR_GREEN)
        for (x, z), (y, block) in membrane.items():
            # Fill steps between adjacent columns so steep sails have no gaps.
            bottom = min(membrane.get(p, (y, block))[0] for p in
                         ((x, z), (x - 1, z), (x + 1, z), (x, z - 1), (x, z + 1)))
            for layer in range(bottom, y + 1):
                put(x, floor + layer, z, block)
        for a, b in ((root, elbow), (elbow, tip), (root, scallop), (root, edge)):
            stroke(a, b, COLOR_GREEN, 2)
        dot(tip, 2, COLOR_GOLD)

    # Sample a spline through the spine, then assign each voxel to its nearest
    # sample so the light belly stays continuous where the segments overlap.
    spine = [(-50, 47, -36, 6), (-33, 39, -40, 6), (-11, 34, -39, 6),
             (12, 39, -28, 5), (35, 46, -32, 5), (50, 43, -49, 4),
             (47, 33, -66, 3), (33, 30, -73, 2), (23, 35, -69, 2),
             (24, 43, -62, 1)]
    samples = []
    for i, (b, c) in enumerate(zip(spine, spine[1:])):
        a = spine[max(0, i - 1)]
        d = spine[min(i + 2, len(spine) - 1)]
        steps = max(abs(v - u) for u, v in zip(b, c))
        for step in range(steps):
            t = step / steps
            samples.append(tuple(
                round((2 * v + (-u + w) * t + (2*u - 5*v + 4*w - k) * t*t +
                       (-u + 3*v - 3*w + k) * t*t*t) / 2)
                for u, v, w, k in zip(a, b, c, d)
            ))
    samples.append(spine[-1])
    body = {}
    for x, y, z, radius in samples:
        for p in sphere(x, y, z, radius, fill=True):
            distance = sum((v - u) ** 2 for u, v in zip((x, y, z), p)) / radius**2
            block = COLOR_WHITE if p[1] < y - radius * .55 else COLOR_GREEN
            if block == COLOR_GREEN and (p[0] + p[1] // 2 + p[2]) % 7 == 0:
                block = COLOR_CYAN
            if p not in body or distance < body[p][0]:
                body[p] = distance, block
    for (x, y, z), (_, block) in body.items():
        put(x, floor + y, z, block)
    for x, y, z, radius in samples[3::5]:
        stroke((x, y + radius - 1, z), (x + 2, y + radius + 1, z), COLOR_GOLD)
    stroke((24, 43, -62), (19, 46, -60), COLOR_CYAN, 2)
    stroke((24, 43, -62), (27, 47, -58), COLOR_CYAN, 2)

    dot((-51, 47, -36), 7, COLOR_GREEN)
    stroke((-54, 45, -36), (-62, 43, -36), COLOR_WHITE, 4)
    stroke((-54, 47, -36), (-62, 46, -36), COLOR_GREEN, 4)
    for side in (-1, 1):
        z = -36 + 6 * side
        dot((-53, 49, z), 2, COLOR_GOLD)
        dot((-54, 49, z + side), 1, COLOR_BLACK)
        stroke((-55, 51, z), (-49, 52, z), COLOR_GREEN, 2)
        dot((-64, 47, -36 + 2 * side), 1, COLOR_BLACK)
        stroke((-47, 51, -36 + 4 * side), (-44, 58, -36 + 7 * side), COLOR_GOLD, 2)
        stroke((-44, 58, -36 + 7 * side), (-48, 62, -36 + 9 * side), COLOR_GOLD)
        stroke((-44, 58, -36 + 7 * side), (-40, 61, -36 + 8 * side), COLOR_GOLD)
        for x, y, lz in ((-28, 37, -40), (19, 40, -29)):
            elbow = (x + 5, y - 6, lz + side * 7)
            paw = (x + 2, y - 10, lz + side * 11)
            stroke((x, y, lz), elbow, COLOR_GREEN, 3)
            stroke(elbow, paw, COLOR_GREEN, 2)
            for dz in (-2, 0, 2):
                stroke(paw, (paw[0] - 3, paw[1] - 1, paw[2] + dz), COLOR_WHITE)

def build_island(put, cx, cz, floor, rx, rz, depth):
    """Build a scalloped grass shelf and layered rock tapering to a jagged tip."""
    surface = set()
    for dx in range(-rx - 3, rx + 4):
        for dz in range(-rz - 3, rz + 4):
            x, z = cx + dx, cz + dz
            angle = math.atan2(dz, dx)
            radius = math.hypot(dx / rx, dz / rz)
            rim = 1 + .045 * math.sin(5 * angle) + .035 * math.cos(8 * angle)
            if radius > rim:
                continue
            surface.add((x, z))
            put(x, floor, z, GRASS)
            rock = max(3, round(depth * (1 - radius / rim)**.75
                                + 3 * math.sin(dx / 3) * math.cos(dz / 4)))
            for dy in range(1, rock + 1):
                stratum = (dy + x // 5 - z // 7) % 13
                block = DIRT if dy <= 2 or stratum == 4 else COBBLE if stratum < 4 else STONE
                put(x, floor - dy, z, block)
    for x, z in sorted(surface):
        for dx, dz in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            if (x + dx, z + dz) not in surface and (x * 7 + z * 11) % 5 == 0:
                for dy in range(1, 5 + (x * 11 + z * 13) % 9):
                    put(x + dx, floor - dy, z + dz, LEAVES)
    return surface


def build_waterfall(put, surface, terrain, cx, cz, floor, axis, side, offset, source, width, drop):
    def at(distance, lane):
        return ((cx + side * distance, cz + lane) if axis == "x"
                else (cx + lane, cz + side * distance))

    for lane in range(offset - width // 2, offset + width // 2 + 1):
        distance = source + abs(lane - offset) // 2
        while at(distance, lane) in surface:
            x, z = at(distance, lane)
            put(x, floor, z, WATER)
            distance += 1
        x, z = at(distance, lane)
        end = drop - 2 * abs(lane - offset)
        for dy in range(end + 1):
            if terrain.get((x, floor - dy, z), EMPTY) not in (EMPTY, CLOUD):
                break
            put(x, floor - dy, z, WATER)


def build_bridge(put, edits, main, garden, floor, axis, side):
    def at(distance, offset):
        return (side * distance, offset) if axis == "x" else (offset, side * distance)

    def full_width(surface, distance):
        return all(at(distance, offset) in surface for offset in range(-3, 4))

    start = max(d for d in range(GARDEN_DISTANCE) if full_width(main, d)) - 2
    end = next(d for d in range(start, GARDEN_DISTANCE) if full_width(garden, d)) + 2

    def deck_y(d):
        return floor - round(4 * math.sin(math.pi * (d - start) / (end - start)))

    for d in range(start, end + 1):
        y = deck_y(d)
        rail_top = max(deck_y(max(start, d - 1)), y, deck_y(min(end, d + 1))) + 1
        post = (d - start) % 5 == 0 or d == end
        for offset in range(-3, 4):
            x, z = at(d, offset)
            put(x, y, z, PLANK)
            # Cut headroom through islands and overhanging cliff foliage.
            for clear_y in range(y + 1, max(floor, y + 2) + 1):
                if (x, clear_y, z) in edits:
                    put(x, clear_y, z, EMPTY)
            if post:
                put(x, y - 1, z, WOOD)
            if abs(offset) == 3:
                for rail_y in range(y + 1, rail_top + 1):
                    put(x, rail_y, z, WOOD)
                if post:
                    put(x, y + 2, z, WOOD)
                    put(x, y + 3, z, COLOR_GOLD)


def build_sunstone(put, x, y, z, number):
    # Amber facets and numbered bands of red inlays distinguish the seven orbs.
    for bx, by, bz in sphere(x, y, z, ORB_RADIUS, fill=True):
        band = abs(by - y) <= 1
        block = BRICK if band else COLOR_GOLD
        if by >= y + 3 and bx == x - 2 and bz in (z - 3, z - 2):
            block = COLOR_WHITE
        put(bx, by, bz, block)
    for mark in range(number):
        angle = math.tau * mark / number
        mx = x + round((ORB_RADIUS - .1) * math.sin(angle))
        mz = z + round((ORB_RADIUS - .1) * math.cos(angle))
        for point in sphere(mx, y, mz, 1, fill=True):
            put(*point, COLOR_RED)


def make_park(terrain):
    """Return absolute block edits; the last drawing at a position wins."""
    ground = [y for (x, y, z), w in terrain.items()
              if x == z == 0 and w in (GRASS, SAND, STONE, CEMENT, DIRT, SNOW, COBBLE)]
    if not ground:
        raise ValueError("Could not find natural ground at the park spawn")
    base = max(ground)
    floor = SKY_Y
    if not 31 <= base < floor - CLIFF_DEPTH or floor + 63 > 255 or floor - MAIN_WATER_DROP < 1:
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

    def tree(tx, tz, height):
        box(tx - 1, tx + 1, floor + 1, floor + height, tz - 1, tz + 1, WOOD)
        for dx, dy, dz, radius in ((0, 0, 0, 5), (3, 2, 0, 4), (-3, -1, 2, 4),
                                    (0, 4, -2, 4)):
            for x, y, z in sphere(tx + dx, floor + height + dy, tz + dz, radius, fill=True):
                put(x, y, z, LEAVES)

    def garden_cover(surface):
        for x, z in sorted(surface):
            if edits[x, floor, z] == GRASS and (x, floor + 1, z) not in edits:
                seed = (x * 17 + z * 31 + x * z * 3) % 61
                if seed < 4:
                    put(x, floor + 1, z, (YELLOW_FLOWER, RED_FLOWER, TALL_GRASS, TALL_GRASS)[seed])

    main = build_island(put, 0, 0, floor, PARK_HALF_WIDTH, PARK_HALF_LENGTH, CLIFF_DEPTH)
    for x, z in sorted(main):
        distance = x*x + (z - 8)**2
        if abs(x) <= 3 or abs(z) <= 3 or 15**2 <= distance <= 19**2:
            put(x, floor, z, CEMENT)
    for tx, tz in TREE_POSITIONS:
        tree(tx, tz, 10 + (tx + tz) % 4)
    for x in (-28, 28):
        build_waterfall(put, main, terrain, 0, 0, floor, "z", 1, x, 20, 7, MAIN_WATER_DROP)

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

    # A layered plinth and a thick CashToken-inspired coin.
    cz = 8
    for dy, radius in ((1, 10), (2, 9), (3, 8)):
        for point in circle_y(0, floor + dy, cz, radius, fill=True):
            put(*point, COBBLE if dy == 2 else CEMENT)
    for dx in range(-13, 14):
        for dy in range(-13, 14):
            distance = dx * dx + dy * dy
            if distance <= 169:
                box(dx, dx, floor + 16 + dy, floor + 16 + dy, cz - 2, cz + 2,
                    COLOR_GOLD if distance >= 121 else COLOR_GREEN)
    letter = ("11110", "10001", "10001", "11110", "10001", "10001", "11110")
    for dy, pixels in enumerate(letter):
        for dx, pixel in enumerate(pixels):
            if pixel == "1":
                for face in (-1, 1):
                    x = face * (dx * 2 - 4)
                    box(min(x, x + face), max(x, x + face),
                        floor + 21 - 2*dy, floor + 22 - 2*dy, cz + 3*face, cz + 3*face,
                        COLOR_WHITE)

    build_dragon(put, floor)

    for axis, side in (("x", -1), ("x", 1), ("z", -1), ("z", 1)):
        cx, cz = (side * GARDEN_DISTANCE, 0) if axis == "x" else (0, side * GARDEN_DISTANCE)
        garden = build_island(put, cx, cz, floor, 21, 21, 33)
        for x, z in sorted(garden):
            if abs(z if axis == "x" else x) <= 3:
                put(x, floor, z, CEMENT)
        for dx in (-4, 4):
            for dz in (-4, 4):
                box(cx + dx, cx + dx, floor + 1, floor + 7, cz + dz, cz + dz, WOOD)
        for dy in range(6):
            radius = 6 - dy
            box(cx - radius, cx + radius, floor + 8 + dy, floor + 8 + dy,
                cz - radius, cz + radius, PLANK if dy == 0 else COLOR_RED)
        put(cx, floor + 14, cz, COLOR_GOLD)
        tx, tz = (cx + side * 14, cz - 4) if axis == "x" else (cx - 4, cz + side * 14)
        tree(tx, tz, 9)
        build_waterfall(put, garden, terrain, cx, cz, floor, axis, side, 8, 6, 5, 48)
        build_bridge(put, edits, main, garden, floor, axis, side)
        garden_cover(garden)
    garden_cover(main)
    for number, (x, z) in enumerate(SPHERE_POSITIONS, 1):
        box(x - 3, x + 3, floor + 1, floor + 1, z - 3, z + 3, COBBLE)
        box(x - 1, x + 1, floor + 2, floor + 3, z - 1, z + 1, CEMENT)
        build_sunstone(put, x, floor + ORB_HEIGHT, z, number)

    if any(pos in edits and block != CLOUD for pos, block in terrain.items()):
        raise ValueError("Sky park intersects natural terrain; raise SKY_Y")
    # Keep the original marker pillar separate from the island collision check.
    for y in range(base + 1, floor):
        if (0, y, TOWER_Z) in edits:
            break
        put(0, y, TOWER_Z, CEMENT)
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
