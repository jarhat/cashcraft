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
    def test_expanded_islands_have_bridges_and_fit_world_bounds(self):
        edits = builder.make_park({(0, 40, 0): builder.GRASS})
        floor = builder.SKY_Y
        for x, z in ((53, 0), (-53, 0), (0, 53), (0, -53)):
            self.assertEqual(edits[x, floor, z], builder.GRASS)
            self.assertEqual(edits[x, floor + 8, z], builder.COLOR_GOLD)
        for x, z in ((35, 0), (-35, 0), (0, 35), (0, -35)):
            self.assertEqual(edits[x, floor, z], builder.PLANK)
        self.assertTrue(all(1 <= y <= 255 for _, y, _ in edits))

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

    def test_each_overlapping_edit_aborts_without_changes(self):
        for table, values in [
            ("block", (0, 0, 1, 180, 1, 0)),
            ("light", (0, 0, 0, 40, -12, 1)),
            ("sign", (0, 0, 1, 181, 1, 0, "existing")),
            ("light", (1, 0, 53, 170, 0, 1)),
        ]:
            with self.subTest(table=table):
                with sqlite3.connect(self.path) as db:
                    placeholders = ",".join("?" for _ in values)
                    db.execute(f"INSERT INTO {table} VALUES ({placeholders})", values)
                with self.assertRaisesRegex(ValueError, "overlaps the park"):
                    builder.add_park(self.path)
                with sqlite3.connect(self.path) as db:
                    self.assertEqual(db.execute("SELECT COUNT(*) FROM block").fetchone()[0], 2 if table == "block" else 1)
                    db.execute(f"DELETE FROM {table} WHERE x=?", (values[2],))

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
