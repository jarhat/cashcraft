import importlib.util
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


class PreviewWorldTests(unittest.TestCase):
    def test_pillar_and_donation_qr(self):
        import segno
        address = "bitcoincash:zqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqweyg7usz"
        with patch.object(builder, "DONATION_ADDRESS", address):
            edits = builder.make_park({(0, 40, 0): builder.GRASS})
        self.assertEqual(edits[0, 100, builder.TOWER_Z], builder.CEMENT)
        self.assertNotIn((1, 100, builder.TOWER_Z), edits)
        rows = list(segno.make(address, error="m", micro=False).matrix_iter(border=4))
        for row, pixels in enumerate(rows):
            for col, dark in enumerate(pixels):
                self.assertEqual(
                    edits[col - len(rows) // 2, builder.SKY_Y + len(rows) - row, builder.DONATION_QR_Z],
                    builder.COLOR_BLACK if dark else builder.COLOR_WHITE,
                )

    def test_islands_have_deep_cliffs_waterfalls_and_walkable_bridges(self):
        edits = builder.make_park({(0, 40, 0): builder.GRASS})
        floor = builder.SKY_Y
        self.assertIn(edits[0, floor - 60, 0], (builder.STONE, builder.COBBLE, builder.DIRT))
        for side in (-1, 1):
            streams = [(x, z) for (x, y, z), w in edits.items()
                       if y == floor - 70 and w == builder.WATER and x * side > 0]
            self.assertGreaterEqual(len(streams), 5)
            for x, z in streams:
                self.assertTrue(all(edits[x, y, z] == builder.WATER
                                    for y in range(floor - 70, floor + 1)))
        for dx, dz in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            deck = sorted((x * dx + z * dz, y) for (x, y, z), block in edits.items()
                          if block == builder.PLANK and x * dz == z * dx
                          and 40 <= x * dx + z * dz <= 80 and y <= floor)
            self.assertGreaterEqual(len(deck), 16)
            self.assertEqual(deck[0][1], floor)
            self.assertEqual(deck[-1][1], floor)
            self.assertLess(min(y for _, y in deck), floor)
            for (d, y), (next_d, next_y) in zip(deck, deck[1:]):
                self.assertEqual(next_d, d + 1)
                self.assertLessEqual(abs(next_y - y), 1)
                self.assertTrue(all(edits.get((d * dx, y + dy, d * dz), builder.EMPTY)
                                    == builder.EMPTY for dy in (1, 2)))
                self.assertEqual(edits[d * dx + 3 * dz, y + 1, d * dz + 3 * dx], builder.WOOD)
            self.assertEqual(edits[dx * builder.GARDEN_DISTANCE, floor + 14,
                                   dz * builder.GARDEN_DISTANCE], builder.COLOR_GOLD)
        self.assertTrue(all(1 <= y <= 255 for _, y, _ in edits))

    def test_seven_large_sunstones_have_distinct_inlays(self):
        edits = builder.make_park({(0, 40, 0): builder.GRASS})
        self.assertEqual(len(set(builder.SPHERE_POSITIONS)), 7)
        y = builder.SKY_Y + builder.ORB_HEIGHT
        previous = 0
        for x, z in builder.SPHERE_POSITIONS:
            self.assertEqual(edits[x, y + 6, z], builder.COLOR_GOLD)
            self.assertEqual(edits[x, y - 6, z], builder.COLOR_GOLD)
            red = sum(edits.get((x + dx, y, z + dz)) == builder.COLOR_RED
                      for dx in range(-7, 8) for dz in range(-7, 8))
            self.assertGreater(red, previous)
            previous = red

    def test_dragon_is_a_single_large_sculpture(self):
        dragon = set()
        builder.build_dragon(lambda x, y, z, _: dragon.add((x, y, z)), builder.SKY_Y)
        self.assertGreaterEqual(max(x for x, _, _ in dragon) - min(x for x, _, _ in dragon), 110)
        self.assertGreaterEqual(max(z for _, _, z in dragon) - min(z for _, _, z in dragon), 95)
        frontier = [dragon.pop()]
        while frontier:
            x, y, z = frontier.pop()
            for pos in ((x - 1, y, z), (x + 1, y, z), (x, y - 1, z),
                        (x, y + 1, z), (x, y, z - 1), (x, y, z + 1)):
                if pos in dragon:
                    dragon.remove(pos)
                    frontier.append(pos)
        self.assertFalse(dragon, f"{len(dragon)} detached dragon voxels")

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


if __name__ == "__main__":
    unittest.main()
