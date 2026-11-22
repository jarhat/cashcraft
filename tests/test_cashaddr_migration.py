import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

from backend.migrate_cashaddr import TABLES, migrate


class CashAddrMigrationTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.world = Path(directory.name) / "netcraft.db"
        self.cashaddr = Path(directory.name) / "cash-addresses.sqlite3"
        with closing(sqlite3.connect(self.world)) as db, db:
            db.executescript("""
                PRAGMA journal_mode=WAL;
                CREATE TABLE block (x INTEGER, y INTEGER, z INTEGER, w INTEGER);
                INSERT INTO block VALUES (1,2,3,0);
                CREATE TABLE mining_rewards (
                    id INTEGER PRIMARY KEY, x INTEGER, y INTEGER, z INTEGER, cash_address TEXT,
                    category TEXT, signed_tx TEXT, txid TEXT, sent_at TEXT, player_name TEXT
                );
                CREATE UNIQUE INDEX mining_rewards_xyz_idx ON mining_rewards (x,y,z);
                INSERT INTO mining_rewards VALUES
                    (42,NULL,NULL,NULL,'legacy','category','signed','pending-txid',NULL,NULL),
                    (43,1,2,3,'miner','category','signed','paid-txid','paid-at','Alice');
                CREATE TABLE mina_mining_progress (cash_address TEXT, category TEXT, blocks INTEGER);
                INSERT INTO mina_mining_progress VALUES ('miner','category',4);
                CREATE TABLE guest_mining_progress (guest_id TEXT, category TEXT, blocks INTEGER);
                INSERT INTO guest_mining_progress VALUES ('guest','category',7);
                CREATE TABLE guest_mining_rewards (guest_id TEXT, x INTEGER, y INTEGER, z INTEGER);
                INSERT INTO guest_mining_rewards VALUES ('guest',2,3,4);
                CREATE TABLE mining_totals (name TEXT PRIMARY KEY, total INTEGER);
                INSERT INTO mining_totals VALUES ('mina_ore',63);
                CREATE TABLE ore_scores (miner TEXT, ore INTEGER, blocks INTEGER);
                INSERT INTO ore_scores VALUES ('miner',83,14);
            """)
            self.expected = {
                name: db.execute(f"SELECT * FROM {name}").fetchall() for name in TABLES
            }
        with closing(sqlite3.connect(self.cashaddr)) as db, db:
            db.executescript("""
                CREATE TABLE cash_addresses (cash_address TEXT PRIMARY KEY);
                INSERT INTO cash_addresses VALUES ('welcome');
                CREATE TABLE token_rewards (cash_address TEXT PRIMARY KEY, txid TEXT);
                INSERT INTO token_rewards VALUES ('welcome','welcome-txid');
                -- An empty schema initialized by the new backend can be replaced.
                CREATE TABLE mining_rewards (id INTEGER PRIMARY KEY);
            """)

    def test_moves_only_mining_tables_and_preserves_ledger(self):
        self.assertEqual(migrate(self.world, self.cashaddr), {
            name: len(rows) for name, rows in self.expected.items()
        })
        with closing(sqlite3.connect(self.world)) as db:
            self.assertEqual(db.execute("SELECT * FROM block").fetchall(), [(1, 2, 3, 0)])
            self.assertEqual(db.execute("SELECT name FROM sqlite_schema WHERE type='table'").fetchall(),
                             [("block",)])
        with closing(sqlite3.connect(self.cashaddr)) as db:
            for name, rows in self.expected.items():
                self.assertEqual(db.execute(f"SELECT * FROM {name}").fetchall(), rows)
            self.assertEqual(db.execute("SELECT * FROM token_rewards").fetchall(),
                             [("welcome", "welcome-txid")])
            self.assertEqual(db.execute("SELECT * FROM cash_addresses").fetchall(), [("welcome",)])
            with self.assertRaises(sqlite3.IntegrityError):
                db.execute("INSERT INTO mining_rewards (x,y,z) VALUES (1,2,3)")
        self.assertEqual(migrate(self.world, self.cashaddr), {})

    def test_refuses_to_merge_a_nonempty_cashaddr_ledger(self):
        with closing(sqlite3.connect(self.cashaddr)) as db, db:
            db.execute("INSERT INTO mining_rewards VALUES (99)")
        with self.assertRaisesRegex(ValueError, "already contains data"):
            migrate(self.world, self.cashaddr)
        with closing(sqlite3.connect(self.world)) as db:
            self.assertEqual(db.execute("SELECT * FROM mining_rewards").fetchall(),
                             self.expected["mining_rewards"])
        with closing(sqlite3.connect(self.cashaddr)) as db:
            self.assertEqual(db.execute("SELECT * FROM mining_rewards").fetchall(), [(99,)])

    def test_rolls_back_both_files_on_a_late_database_error(self):
        with closing(sqlite3.connect(self.cashaddr)) as db, db:
            db.execute("CREATE VIEW ore_scores AS SELECT * FROM token_rewards")
        with self.assertRaises(sqlite3.OperationalError):
            migrate(self.world, self.cashaddr)
        with closing(sqlite3.connect(self.world)) as db:
            for name, rows in self.expected.items():
                self.assertEqual(db.execute(f"SELECT * FROM {name}").fetchall(), rows)
        with closing(sqlite3.connect(self.cashaddr)) as db:
            self.assertEqual(db.execute("PRAGMA table_info(mining_rewards)").fetchall(),
                             [(0, "id", "INTEGER", 0, None, 1)])
