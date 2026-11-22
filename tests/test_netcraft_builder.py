from collections import deque
import importlib.util
import json
import math
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
import sys


spec = importlib.util.spec_from_file_location(
    "netcraft_builder", Path(__file__).resolve().parents[1] / "NetCraft" / "builder.py"
)
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)
TOWER_GROUND = {(0, 40, builder.TOWER_Z): builder.GRASS}


class PreviewWorldTests(unittest.TestCase):
    def test_pillar_spheres_and_donation_qr(self):
        import segno
        address = "bitcoincash:zqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqweyg7usz"
        with patch.object(builder, "DONATION_ADDRESS", address):
            edits = builder.make_park(TOWER_GROUND)
        self.assertEqual(edits[0, 100, builder.TOWER_Z], builder.CEMENT)
        self.assertNotIn((1, 100, builder.TOWER_Z), edits)
        rows = list(segno.make(address, error="m", micro=False).matrix_iter(border=4))
        for row, pixels in enumerate(rows):
            for col, dark in enumerate(pixels):
                self.assertEqual(
                    edits[col - len(rows) // 2, builder.SKY_Y + len(rows) - row, builder.DONATION_QR_Z],
                    builder.COLOR_BLACK if dark else builder.COLOR_WHITE,
                )
        dragon = builder.make_park({}, ["dragon"])
        self.assertFalse(dragon.keys() & {
            (col - len(rows) // 2, builder.SKY_Y + len(rows) - row, builder.DONATION_QR_Z)
            for row in range(len(rows)) for col in range(len(rows))
        })

    def test_expanded_islands_have_bridges_and_fit_world_bounds(self):
        edits = builder.make_park(TOWER_GROUND)
        floor = builder.SKY_Y
        for x, z in ((53, 0), (-53, 0), (0, 53), (0, -53)):
            self.assertEqual(edits[x, floor, z], builder.GRASS)
            self.assertEqual(edits[x, floor + 8, z], builder.COLOR_GOLD)
        for x, z in ((35, 0), (-35, 0), (0, 35), (0, -35)):
            self.assertEqual(edits[x, floor, z], builder.PLANK)
        for dx, dz in ((-1, 0), (1, 0), (0, -1), (0, 1)):
            for distance in range(64, 97):
                self.assertEqual(edits[dx * distance, floor, dz * distance], builder.PLANK)
                self.assertEqual(edits[dx * distance, floor + 1, dz * distance], builder.EMPTY)
            self.assertIn((dx * 108, floor - 8, dz * 108), edits)
        self.assertEqual(edits[0, floor + 16, -108], builder.COLOR_GOLD)
        self.assertEqual(edits[0, floor - 24, 123], builder.WATER)
        self.assertIn(builder.GLASS, [block for (x, y, z), block in edits.items() if y > floor and z < -100])
        self.assertTrue(all(1 <= y <= 255 for _, y, _ in edits))

        # Reach every island from the plaza, and every outer island through the loop alone.
        def walk(start, perimeter_only=False):
            visited = {start}
            frontier = deque([start])
            while frontier:
                x, z = frontier.popleft()
                for step_x, step_z in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    nx, nz = point = (x + step_x, z + step_z)
                    if point in visited or (perimeter_only and max(abs(nx), abs(nz)) < 94):
                        continue
                    if edits.get((nx, floor, nz), builder.EMPTY) in (builder.EMPTY, builder.WATER):
                        continue
                    if any(edits.get((nx, floor + dy, nz), builder.EMPTY)
                           not in (builder.EMPTY, builder.RED_FLOWER, builder.YELLOW_FLOWER)
                           for dy in (1, 2)):
                        continue
                    visited.add(point)
                    frontier.append(point)
            return visited

        outer = {(x, z) for x in (-108, 0, 108) for z in (-108, 0, 108) if x or z}
        self.assertTrue(outer <= walk((108, 0), perimeter_only=True))
        self.assertTrue(outer | {(-53, 0), (53, 0), (0, -53), (0, 53)} <= walk((0, 0)))

    def test_sculpture_modules_are_independent_and_scaled(self):
        dragon = builder.make_park({}, ["dragon"])
        xs, ys, zs = zip(*dragon)
        self.assertGreater(max(xs) - min(xs), 200)
        self.assertGreater(max(zs) - min(zs), 75)
        self.assertGreater(min(ys), builder.SKY_Y + 20)
        self.assertLessEqual(max(ys), 255)

        orbs = builder.make_park({}, ["orbs"])
        self.assertFalse(orbs.keys() & dragon.keys())
        self.assertEqual(len(builder.ORB_DISPLAYS), 7)
        for number, (x, z, axis) in enumerate(builder.ORB_DISPLAYS, 1):
            y = builder.SKY_Y + 7
            self.assertEqual(orbs[x, y, z], builder.COLOR_GOLD)
            for side in (-1, 1):
                red = 0
                for u in range(-5, 6):
                    for v in range(-5, 6):
                        if u*u + v*v >= 25:
                            continue
                        depth = side * math.isqrt(25 - u*u - v*v)
                        dx, dz = (depth, u) if axis == "x" else (u, depth)
                        red += orbs.get((x + dx, y + v, z + dz)) == builder.COLOR_RED
                self.assertEqual(red, number * 5)

    def test_default_command_creates_compose_world(self):
        with patch.object(sys, "argv", ["builder.py"]), \
             patch.object(Path, "mkdir"), patch.object(builder, "initialize_park") as initialize:
            builder.main()
        self.assertEqual(initialize.call_args.args[0], Path(builder.__file__).resolve().parent.parent / "data" / "netcraft.db")


class ExistingWorldParkTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "world.db"
        with sqlite3.connect(self.path) as db:
            db.executescript("""
                CREATE TABLE block (p INTEGER, q INTEGER, x INTEGER, y INTEGER, z INTEGER, w INTEGER);
                CREATE UNIQUE INDEX blocks ON block(p,q,x,y,z);
                CREATE TABLE light (p INTEGER, q INTEGER, x INTEGER, y INTEGER, z INTEGER, w INTEGER);
                CREATE TABLE sign (p INTEGER, q INTEGER, x INTEGER, y INTEGER, z INTEGER, face INTEGER, text TEXT);
                INSERT INTO block VALUES (3,3,100,60,100,4);
            """)
        self.terrain = patch.object(builder, "terrain_in_park", return_value={})
        self.park = patch.object(builder, "make_park", return_value={(0, 180, 0): 6, (1, 180, 1): 0})
        self.terrain.start()
        self.park.start()
        self.addCleanup(self.terrain.stop)
        self.addCleanup(self.park.stop)

    def test_existing_world_is_preserved_and_chunk_edges_are_mirrored(self):
        builder.add_park(self.path)
        with sqlite3.connect(self.path) as db:
            rows = set(db.execute("SELECT * FROM block"))
        self.assertIn((3, 3, 100, 60, 100, 4), rows)
        self.assertIn((0, 0, 0, 180, 0, 6), rows)
        self.assertIn((-1, 0, 0, 180, 0, -6), rows)
        self.assertIn((0, -1, 0, 180, 0, -6), rows)
        self.assertIn((-1, -1, 0, 180, 0, -6), rows)
        self.assertIn((0, 0, 1, 180, 1, 0), rows)

    def test_overlapping_edits_are_preserved(self):
        for table, values in [
            ("block", (0, 0, 1, 180, 1, 0)),
            ("light", (0, 0, 1, 180, 1, 1)),
            ("sign", (0, 0, 1, 180, 1, 0, "existing")),
        ]:
            with self.subTest(table=table):
                with tempfile.TemporaryDirectory() as directory:
                    path = Path(directory) / "copy.db"
                    with sqlite3.connect(self.path) as source, sqlite3.connect(path) as target:
                        source.backup(target)
                        placeholders = ",".join("?" for _ in values)
                        target.execute(f"INSERT INTO {table} VALUES ({placeholders})", values)
                    builder.add_park(path)
                    with sqlite3.connect(path) as db:
                        self.assertEqual(db.execute(f"SELECT * FROM {table} WHERE x=1").fetchone(), values)
                        self.assertEqual(db.execute("SELECT COUNT(*) FROM block WHERE x=1").fetchone()[0], 1 if table == "block" else 0)
                        self.assertEqual(db.execute("SELECT w FROM block WHERE p=0 AND q=0 AND x=0 AND y=180 AND z=0").fetchone()[0], 6)

    def test_failed_insert_rolls_back_all_rows(self):
        with sqlite3.connect(self.path) as db:
            db.execute("CREATE TRIGGER reject_park BEFORE INSERT ON block WHEN NEW.x=1 BEGIN SELECT RAISE(ABORT, 'rejected'); END")
        with self.assertRaises(sqlite3.IntegrityError):
            builder.add_park(self.path)
        with sqlite3.connect(self.path) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM block").fetchone()[0], 1)

    def test_missing_world_is_not_created(self):
        missing = self.path.parent / "missing.db"
        with self.assertRaises(sqlite3.OperationalError):
            builder.add_park(missing)
        self.assertFalse(missing.exists())

    def write_terrain(self, name, edits, origin=None):
        path = self.path.parent / name
        module = {"version": 1, "edits": edits}
        if origin is not None:
            module["origin"] = origin
        path.write_text(json.dumps(module), encoding="utf-8")
        return path

    def test_terrain_only_layers_modules_and_preserves_saved_border_rows(self):
        floor = self.write_terrain("floor.json", [
            {"from": [1, 0, 0], "to": [-1, 0, 0], "block": 8},
        ], [-32, 160, 0])
        trim = self.write_terrain("trim.json", [
            {"at": [-33, 160, 0], "block": 36},
            {"at": [-31, 160, 0], "block": 0},
        ])
        with sqlite3.connect(self.path) as db:
            # Only the neighboring chunk has a saved edit at this position.
            db.execute("INSERT INTO block VALUES (-2,0,-32,160,0,-4)")
        with patch.object(sys, "argv", ["builder.py", "--apply-terrain", str(self.path),
                                       "--terrain", str(floor), "--terrain", str(trim)]):
            builder.main()
        builder.terrain_in_park.assert_not_called()
        with sqlite3.connect(self.path) as db:
            self.assertEqual(db.execute("SELECT p,q,w FROM block WHERE x=-32").fetchall(), [(-2, 0, -4)])
            self.assertEqual(sorted(db.execute("SELECT p,q,w FROM block WHERE x=-33")), [(-2, -1, -36), (-2, 0, 36), (-1, -1, -36), (-1, 0, -36)])
            self.assertEqual(sorted(db.execute("SELECT p,q,w FROM block WHERE x=-31")), [(-1, -1, 0), (-1, 0, 0)])

    def test_bad_module_cannot_partially_apply_valid_modules(self):
        valid = self.write_terrain("valid.json", [{"at": [0, 155, 0], "block": 8}])
        for edit, error in (
            ({"at": [0, 256, 0], "block": 8}, "outside the world"),
            ({"at": [0, 155, 0], "block": True}, "recognized NetCraft block ID"),
            ({"from": [0, 1, 0], "to": [999, 255, 99], "block": 8}, "250,000 block edits"),
        ):
            with self.subTest(edit=edit):
                invalid = self.write_terrain("invalid.json", [edit])
                with patch.object(sys, "argv", ["builder.py", "--apply-terrain", str(self.path),
                                               "--terrain", str(valid), "--terrain", str(invalid)]), \
                     patch.object(sys, "stderr") as stderr, self.assertRaises(SystemExit):
                    builder.main()
                self.assertIn(error, stderr.write.call_args.args[0])
                with sqlite3.connect(self.path) as db:
                    self.assertEqual(db.execute("SELECT COUNT(*) FROM block").fetchone()[0], 1)

    def test_replace_blocks_updates_border_rows_but_keeps_signs_and_lights(self):
        patch_file = self.write_terrain("patch.json", [
            {"at": [0, 180, 0], "block": 0},
            {"at": [1, 180, 1], "block": 8},
            {"at": [2, 180, 2], "block": 8},
            {"at": [-32, 180, 0], "block": 36},
        ])
        with sqlite3.connect(self.path) as db:
            db.executemany("INSERT INTO block VALUES (?,?,?,?,?,?)",
                           builder.park_rows({(0, 180, 0): 6, (1, 180, 1): 4, (2, 180, 2): 4}))
            db.execute("INSERT INTO sign VALUES (0,0,1,180,1,0,'test')")
            db.execute("INSERT INTO light VALUES (0,0,2,180,2,1)")
            # A saved border copy without an owner row is also replaced.
            db.execute("INSERT INTO block VALUES (-2,0,-32,180,0,-4)")
        with patch.object(sys, "argv", ["builder.py", "--apply-terrain", str(self.path),
                                       "--terrain", str(patch_file), "--replace-blocks"]):
            builder.main()
        with sqlite3.connect(self.path) as db:
            self.assertEqual(db.execute("SELECT w FROM block WHERE x=0").fetchall(), [(0,)] * 4)
            self.assertEqual(db.execute("SELECT w FROM block WHERE x IN (1,2)").fetchall(), [(4,), (4,)])
            self.assertEqual(db.execute("SELECT text FROM sign").fetchone(), ("test",))
            self.assertEqual(db.execute("SELECT w FROM light").fetchone(), (1,))
            self.assertEqual(set(db.execute("SELECT * FROM block WHERE x=-32")),
                             set(builder.park_rows({(-32, 180, 0): 36})))


if __name__ == "__main__":
    unittest.main()
