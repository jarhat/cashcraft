import importlib.util
import io
import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient
from PIL import Image

sys.path.insert(0, str(Path(__file__).parents[1] / "backend"))
os.environ.update({
    "BCH_NETWORK": "mainnet",
    "BCH_RPC_USER": "test",
    "BCH_RPC_PASSWORD": "test",
    "BCH_REWARD_CATEGORY": "b" * 64,
})
spec = importlib.util.spec_from_file_location("cashcraft_backend", Path(__file__).parents[1] / "backend/main.py")
backend = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backend)


class RewardTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = patch.object(backend, "DB_PATH", Path(self.tmp.name) / "addresses.sqlite3")
        self.path.start()
        self.addCleanup(self.path.stop)
        backend.init_db()

    def test_check_balance_reads_only_the_payout_wallet(self):
        with patch.object(backend, "bch_rpc", return_value="1.00001234") as rpc:
            self.assertEqual(backend.check_balance(), 100001234)
            rpc.assert_called_once_with("getbalance", [], wallet=True)
        with patch.object(backend, "bch_rpc", side_effect=RuntimeError("unavailable")):
            with self.assertRaises(RuntimeError):
                backend.check_balance()

    def test_craft_social_preview_contains_donation_qr(self):
        address = "bitcoincash:zqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqweyg7usz"
        client = TestClient(backend.app)
        with sqlite3.connect(backend.DB_PATH) as db:
            db.execute("INSERT INTO donation_addresses (network, address) VALUES (?, ?)", ("mainnet", address))
        with patch.object(backend, "bch_rpc", side_effect=AssertionError("preview must not call BCHN")):
            response = client.get("/api/craft-preview.png")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["content-type"], "image/png")
        with Image.open(io.BytesIO(response.content)) as image:
            self.assertEqual(image.size, (1200, 675))
            qr = list(backend.segno.make(address, error="h").matrix)
            scale = min(image.size) // (3 * (len(qr) + 8))
            left = image.width - (len(qr) + 8) * scale - 28
            top = image.height - (len(qr) + 8) * scale - 74
            for y, row in enumerate(qr):
                for x, dark in enumerate(row):
                    pixel = image.getpixel((left + (x + 4) * scale, top + (y + 4) * scale))
                    self.assertEqual(pixel, (0, 0, 0) if dark else (255, 255, 255))

    def test_craft_social_preview_without_donation_address_still_serves_dragon(self):
        with patch.object(backend, "bch_rpc", side_effect=AssertionError("preview must not call BCHN")):
            response = TestClient(backend.app).get("/api/craft-preview.png")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["cache-control"], "public, max-age=30")
        with Image.open(io.BytesIO(response.content)) as image:
            self.assertEqual(image.size, (1200, 675))

    def test_craft_social_preview_reports_missing_artwork(self):
        with patch.dict(os.environ, {"CRAFT_PREVIEW_IMAGE": str(Path(self.tmp.name) / "missing.png")}):
            self.assertEqual(TestClient(backend.app).get("/api/craft-preview.png").status_code, 503)

    def test_mining_reward_retries_the_same_transaction(self):
        path = Path(self.tmp.name) / "netcraft.sqlite3"
        address = "bitcoincash:zqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqweyg7usz"
        with sqlite3.connect(path) as db:
            db.execute("""CREATE TABLE mining_rewards (
                id INTEGER PRIMARY KEY, cash_address TEXT, category TEXT,
                signed_tx TEXT, txid TEXT, sent_at TEXT
            )""")
            db.execute("INSERT INTO mining_rewards (cash_address, category) VALUES (?, ?)", (address, "a" * 64))
        with patch.object(backend, "NETCRAFT_DB_PATH", str(path)), \
             patch.object(backend, "NETCRAFT_MINING_REWARDS_ENABLED", "true"), \
             patch.object(backend, "build_reward_transaction", return_value=("abcd", "c" * 64)) as build:
            with patch.object(backend, "bch_rpc", side_effect=[RuntimeError("timeout"), RuntimeError("unavailable")]):
                with self.assertRaises(RuntimeError):
                    backend.process_one_mining_reward(1)
            with patch.object(backend, "bch_rpc", return_value="c" * 64) as rpc:
                self.assertTrue(backend.process_one_mining_reward())
                rpc.assert_called_once_with("sendrawtransaction", ["abcd"])
            self.assertFalse(backend.process_one_mining_reward())
            build.assert_called_once_with(address, "a" * 64, mining=True)

    def test_worker_retries_unsigned_mining_reward_for_saved_address(self):
        path = Path(self.tmp.name) / "netcraft.sqlite3"
        address = "bitcoincash:zqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqweyg7usz"
        backend.save_cash_address(address, "bitcoincash", 2)
        with sqlite3.connect(path) as db:
            db.execute("""CREATE TABLE mining_rewards (
                id INTEGER PRIMARY KEY, cash_address TEXT, category TEXT,
                signed_tx TEXT, txid TEXT, sent_at TEXT
            )""")
            db.execute("INSERT INTO mining_rewards (cash_address, category) VALUES (?, ?)", (address, "b" * 64))
        with patch.object(backend, "NETCRAFT_DB_PATH", str(path)), \
             patch.object(backend, "NETCRAFT_MINING_REWARDS_ENABLED", "true"), \
             patch.object(backend, "build_reward_transaction", side_effect=[RuntimeError("offline"), ("abcd", "c" * 64)]), \
             patch.object(backend, "bch_rpc", return_value="c" * 64):
            with self.assertRaisesRegex(RuntimeError, "offline"):
                backend.process_one_mining_reward(1)
            self.assertTrue(backend.process_one_mining_reward())
            self.assertFalse(backend.process_one_mining_reward())
        with sqlite3.connect(path) as db:
            self.assertIsNotNone(db.execute("SELECT sent_at FROM mining_rewards").fetchone()[0])

    def test_mining_payout_is_built_and_broadcast_in_one_request(self):
        path = Path(self.tmp.name) / "netcraft.sqlite3"
        address = "bitcoincash:zqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqweyg7usz"
        with sqlite3.connect(path) as db:
            db.execute("""CREATE TABLE mining_rewards (
                id INTEGER PRIMARY KEY, cash_address TEXT, category TEXT,
                signed_tx TEXT, txid TEXT, sent_at TEXT
            )""")
            db.execute("INSERT INTO mining_rewards (cash_address, category) VALUES (?, ?)", (address, "a" * 64))
        with patch.object(backend, "NETCRAFT_DB_PATH", str(path)), \
             patch.object(backend, "NETCRAFT_MINING_REWARDS_ENABLED", "true"), \
             patch.object(backend, "NETCRAFT_REWARD_WAKE_SECRET", "test-secret"), \
             patch.object(backend, "build_reward_transaction", return_value=("abcd", "c" * 64)) as build, \
             patch.object(backend, "bch_rpc", return_value="c" * 64) as rpc:
            client = TestClient(backend.app)
            self.assertEqual(client.post("/api/internal/netcraft-mining-reward/1").status_code, 403)
            headers = {"Authorization": "Bearer test-secret"}
            self.assertEqual(client.post("/api/internal/netcraft-mining-reward/1", headers=headers).status_code, 204)
            self.assertEqual(client.post("/api/internal/netcraft-mining-reward/1", headers=headers).status_code, 204)
            build.assert_called_once_with(address, "a" * 64, mining=True)
            rpc.assert_called_once_with("sendrawtransaction", ["abcd"])

    def test_distinct_ores_for_same_address_broadcast_separate_transactions(self):
        path = Path(self.tmp.name) / "netcraft.sqlite3"
        address = "bitcoincash:zqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqweyg7usz"
        with sqlite3.connect(path) as db:
            db.execute("""CREATE TABLE mining_rewards (
                id INTEGER PRIMARY KEY, cash_address TEXT, category TEXT,
                signed_tx TEXT, txid TEXT, sent_at TEXT
            )""")
            db.executemany("INSERT INTO mining_rewards (id, cash_address, category) VALUES (?, ?, ?)",
                           [(1, address, "a" * 64), (2, address, "a" * 64)])
        with patch.object(backend, "NETCRAFT_DB_PATH", str(path)), \
             patch.object(backend, "NETCRAFT_MINING_REWARDS_ENABLED", "true"), \
             patch.object(backend, "NETCRAFT_REWARD_WAKE_SECRET", "test-secret"), \
             patch.object(backend, "build_reward_transaction",
                          side_effect=[("abcd", "c" * 64), ("ef01", "d" * 64)]) as build, \
             patch.object(backend, "bch_rpc", side_effect=["c" * 64, "d" * 64]) as rpc:
            client = TestClient(backend.app)
            headers = {"Authorization": "Bearer test-secret"}
            self.assertEqual(client.post("/api/internal/netcraft-mining-reward/1", headers=headers).status_code, 204)
            self.assertEqual(client.post("/api/internal/netcraft-mining-reward/2", headers=headers).status_code, 204)
            self.assertEqual(build.call_count, 2)
            self.assertEqual([call.args for call in rpc.call_args_list],
                             [("sendrawtransaction", ["abcd"]), ("sendrawtransaction", ["ef01"])])

    def test_pending_signed_wallet_payout_prevents_conflicting_mining_transaction(self):
        path = Path(self.tmp.name) / "netcraft.sqlite3"
        address = "bitcoincash:zqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqweyg7usz"
        with sqlite3.connect(path) as db:
            db.execute("""CREATE TABLE mining_rewards (
                id INTEGER PRIMARY KEY, cash_address TEXT, category TEXT,
                signed_tx TEXT, txid TEXT, sent_at TEXT
            )""")
            db.execute("INSERT INTO mining_rewards (cash_address, category) VALUES (?, ?)", (address, "a" * 64))
        with sqlite3.connect(backend.DB_PATH) as db:
            db.execute("INSERT INTO token_rewards (cash_address, category, signed_tx, txid) VALUES (?, ?, ?, ?)",
                       (address, "b" * 64, "01", "d" * 64))
        with patch.object(backend, "NETCRAFT_DB_PATH", str(path)), \
             patch.object(backend, "NETCRAFT_MINING_REWARDS_ENABLED", "true"), \
             patch.object(backend, "build_reward_transaction") as build:
            with self.assertRaisesRegex(RuntimeError, "requires recovery"):
                backend.process_one_mining_reward(1)
            build.assert_not_called()

    def test_immediate_payout_attempts_each_requested_reward_id(self):
        path = Path(self.tmp.name) / "netcraft.sqlite3"
        address = "bitcoincash:zqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqweyg7usz"
        with sqlite3.connect(path) as db:
            db.execute("""CREATE TABLE mining_rewards (
                id INTEGER PRIMARY KEY, cash_address TEXT, category TEXT,
                signed_tx TEXT, txid TEXT, sent_at TEXT
            )""")
            db.executemany("INSERT INTO mining_rewards (id, cash_address, category) VALUES (?, ?, ?)",
                           [(1, address, "a" * 64), (2, address, "a" * 64)])
        with patch.object(backend, "NETCRAFT_DB_PATH", str(path)), \
             patch.object(backend, "NETCRAFT_MINING_REWARDS_ENABLED", "true"), \
             patch.object(backend, "NETCRAFT_REWARD_WAKE_SECRET", "test-secret"), \
             patch.object(backend, "build_reward_transaction", return_value=("abcd", "c" * 64)) as build, \
             patch.object(backend, "bch_rpc", return_value="c" * 64):
            client = TestClient(backend.app)
            headers = {"Authorization": "Bearer test-secret"}
            self.assertEqual(client.post("/api/internal/netcraft-mining-reward/1", headers=headers).status_code, 204)
            self.assertEqual(client.post("/api/internal/netcraft-mining-reward/2", headers=headers).status_code, 204)
            self.assertEqual(build.call_count, 2)

    def test_mining_rewards_disabled_do_not_open_database(self):
        with patch.object(backend, "NETCRAFT_MINING_REWARDS_ENABLED", "false"), \
             patch.object(backend, "NETCRAFT_DB_PATH", str(Path(self.tmp.name) / "missing.sqlite3")):
            self.assertFalse(backend.process_one_mining_reward())

    def test_missing_mining_database_is_created_automatically(self):
        path = Path(self.tmp.name) / "missing" / "netcraft.sqlite3"
        with patch.object(backend, "NETCRAFT_MINING_REWARDS_ENABLED", "true"), \
             patch.object(backend, "NETCRAFT_DB_PATH", str(path)):
            self.assertFalse(backend.process_one_mining_reward())
        self.assertTrue(path.exists())
        with sqlite3.connect(path) as db:
            self.assertIsNotNone(
                db.execute(
                    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'mining_rewards'"
                ).fetchone()
            )
            db.execute(
                "INSERT INTO mining_rewards (x, y, z, cash_address, category) VALUES (?, ?, ?, ?, ?)",
                (1, 2, 3, "address", "a" * 64),
            )
            with self.assertRaises(sqlite3.IntegrityError):
                db.execute(
                    "INSERT INTO mining_rewards (x, y, z, cash_address, category) VALUES (?, ?, ?, ?, ?)",
                    (1, 2, 3, "another", "a" * 64),
                )

    def test_mining_retries_do_not_defer_subsequent_rewards(self):
        path = Path(self.tmp.name) / "netcraft.sqlite3"
        address = "bitcoincash:zqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqweyg7usz"
        with sqlite3.connect(path) as db:
            db.execute("""CREATE TABLE mining_rewards (
                id INTEGER PRIMARY KEY, cash_address TEXT, category TEXT,
                signed_tx TEXT, txid TEXT, sent_at TEXT
            )""")
            db.executemany("INSERT INTO mining_rewards VALUES (?, ?, ?, ?, ?, NULL)", [
                (1, address, "a" * 64, "abcd", "c" * 64),
                (2, address, "a" * 64, "ef01", "d" * 64),
            ])
        with patch.object(backend, "NETCRAFT_DB_PATH", str(path)), \
             patch.object(backend, "NETCRAFT_MINING_REWARDS_ENABLED", "true"):
            with patch.object(backend, "bch_rpc", side_effect=[RuntimeError("timeout"), RuntimeError("unavailable")]):
                with self.assertRaises(RuntimeError):
                    backend.process_one_mining_reward()
            with patch.object(backend, "bch_rpc", return_value="c" * 64):
                self.assertTrue(backend.process_one_mining_reward())
            with patch.object(backend, "bch_rpc", return_value="d" * 64):
                self.assertTrue(backend.process_one_mining_reward())
            self.assertFalse(backend.process_one_mining_reward())

    def test_mining_rewards_for_multiple_addresses_are_processed(self):
        path = Path(self.tmp.name) / "netcraft.sqlite3"
        with sqlite3.connect(path) as db:
            db.execute("""CREATE TABLE mining_rewards (
                id INTEGER PRIMARY KEY, cash_address TEXT, category TEXT,
                signed_tx TEXT, txid TEXT, sent_at TEXT
            )""")
            db.executemany("INSERT INTO mining_rewards VALUES (?, ?, ?, ?, ?, NULL)", [
                (1, "first", "a" * 64, "01", "1" * 64),
                (2, "first", "a" * 64, "02", "2" * 64),
                (3, "second", "a" * 64, "03", "3" * 64),
            ])
        with patch.object(backend, "NETCRAFT_DB_PATH", str(path)), \
             patch.object(backend, "NETCRAFT_MINING_REWARDS_ENABLED", "true"), \
             patch.object(backend, "validate_token_aware_cashaddr"), \
             patch.object(backend, "bch_rpc", side_effect=["1" * 64, "2" * 64, "3" * 64]) as rpc:
            self.assertTrue(backend.process_one_mining_reward())
            self.assertTrue(backend.process_one_mining_reward())
            self.assertTrue(backend.process_one_mining_reward())
            self.assertFalse(backend.process_one_mining_reward())
            self.assertEqual([call.args[1] for call in rpc.call_args_list], [["01"], ["02"], ["03"]])

    def test_mina_total_counts_only_sent_rewards_in_current_category(self):
        path = Path(self.tmp.name) / "netcraft.sqlite3"
        with sqlite3.connect(backend.DB_PATH) as db:
            for table in ("token_rewards",):
                db.execute(f"INSERT INTO {table} (cash_address, category, sent_at) VALUES (?, ?, ?)", (table, "b" * 64, "now"))
                db.execute(f"INSERT INTO {table} (cash_address, category) VALUES (?, ?)", (table + "-pending", "b" * 64))
                db.execute(f"INSERT INTO {table} (cash_address, category, sent_at) VALUES (?, ?, ?)", (table + "-other", "a" * 64, "now"))
        with sqlite3.connect(path) as db:
            db.execute("CREATE TABLE mining_rewards (category TEXT, sent_at TEXT)")
            db.executemany("INSERT INTO mining_rewards VALUES (?, ?)", [
                ("b" * 64, "now"), ("b" * 64, None), ("a" * 64, "now"),
            ])
        client = TestClient(backend.app)
        with patch.object(backend, "NETCRAFT_DB_PATH", str(path)):
            self.assertEqual(client.get("/api/mina-rewards-sent").json(), {"sent": "2"})
        with patch.object(backend, "NETCRAFT_DB_PATH", str(path) + "-missing"):
            self.assertEqual(client.get("/api/mina-rewards-sent").json(), {"sent": "1"})

    def test_chain_status_uses_cached_node_data_and_reports_sync(self):
        info = {
            "chain": "main", "blocks": 800000, "headers": 800002,
            "difficulty": 123.5, "bestblockhash": "A" * 64,
            "initialblockdownload": False, "private_field": "not exposed",
        }
        client = TestClient(backend.app)
        with patch.object(backend, "_chain_status_cache", None), \
             patch.object(backend.time, "monotonic", return_value=100), \
             patch.object(backend, "bch_rpc", return_value=info) as rpc:
            first = client.get("/api/chain-status")
            second = client.get("/api/chain-status")
            self.assertEqual(first.status_code, 200)
            self.assertEqual(first.json(), {
                "network": "mainnet", "blocks": 800000, "headers": 800002,
                "difficulty": 123.5, "best_block_hash": "a" * 64, "syncing": True,
            })
            self.assertEqual(second.json(), first.json())
            rpc.assert_called_once_with("getblockchaininfo", [])

    def test_chain_status_does_not_serve_expired_or_invalid_data(self):
        client = TestClient(backend.app)
        with patch.object(backend, "_chain_status_cache", {"blocks": 1}), \
             patch.object(backend, "_chain_status_cached_at", 1.0), \
             patch.object(backend.time, "monotonic", return_value=30), \
             patch.object(backend, "bch_rpc", side_effect=RuntimeError("secret RPC details")):
            response = client.get("/api/chain-status")
            self.assertEqual(response.status_code, 503)
            self.assertNotIn("secret", response.text)
        with patch.object(backend, "_chain_status_cache", None), \
             patch.object(backend, "bch_rpc", return_value={"chain": "main"}):
            self.assertEqual(client.get("/api/chain-status").status_code, 503)

    def test_only_new_addresses_are_queued_once(self):
        with sqlite3.connect(backend.DB_PATH) as db:
            db.execute("INSERT INTO cash_addresses (cash_address, network, prefix, address_type) VALUES ('old', 'mainnet', 'bitcoincash', 2)")
        backend.save_cash_address("old", "bitcoincash", 2)
        backend.save_cash_address("new", "bitcoincash", 2)
        backend.save_cash_address("new", "bitcoincash", 2)
        with sqlite3.connect(backend.DB_PATH) as db:
            rows = db.execute("SELECT cash_address, category FROM token_rewards ORDER BY cash_address").fetchall()
            self.assertEqual(rows, [("new", "b" * 64)])

    def test_short_links_one_time_persistent_and_expiry(self):
        client = TestClient(backend.app)
        body = {
            "address": "bitcoincash:zqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqweyg7usz",
            "category": "a" * 64, "amount": "5", "note": "thanks", "one_time": True, "expires_in": "1d",
        }
        one = client.post("/api/short-link", json=body).json()
        opened = client.post(f"/api/short-link/{one['id']}/open")
        self.assertEqual(opened.json()["note"], "thanks")
        self.assertEqual(client.post(f"/api/short-link/{one['id']}/open").status_code, 404)
        keep = client.post("/api/short-link", json={**body, "one_time": False}).json()
        for _ in range(2):
            self.assertEqual(client.post(f"/api/short-link/{keep['id']}/open").status_code, 200)
        with sqlite3.connect(backend.DB_PATH) as db:
            db.execute("UPDATE short_links SET expires_at = 1")
        backend.purge_expired_short_links()
        self.assertEqual(client.post(f"/api/short-link/{keep['id']}/open").status_code, 404)
        self.assertEqual(client.post("/api/short-link", json={**body, "amount": "0"}).status_code, 422)
        self.assertEqual(client.post("/api/short-link", json={**body, "expires_in": "1y"}).status_code, 422)

    def test_unfurl_preview_and_qr_never_expose_note_or_consume_one_time_link(self):
        client = TestClient(backend.app)
        body = {
            "address": "bitcoincash:zqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqweyg7usz",
            "category": "a" * 64, "amount": "5", "note": "private-note", "one_time": True, "expires_in": "1d",
        }
        link = client.post("/api/short-link", json=body).json()
        headers = {"X-Original-URI": f"/s/{link['id']}", "X-Preview-Origin": "https://ctf.example"}
        page = client.get("/api/preview", headers=headers)
        self.assertIn(f"https://ctf.example/api/qr.png?s={link['id']}", page.text)
        self.assertNotIn("private-note", page.text)
        qr = client.get(f"/api/qr.png?s={link['id']}", headers=headers)
        self.assertTrue(qr.content.startswith(b"\x89PNG"))
        with patch.object(backend.segno, "make", wraps=backend.segno.make) as make_qr:
            self.assertEqual(client.get(f"/api/qr.png?s={link['id']}", headers=headers).status_code, 200)
            self.assertEqual(make_qr.call_args.args[0], f"https://ctf.example/s/{link['id']}")
        self.assertEqual(client.get(f"/api/qr.png?s={link['id']}").status_code, 400)
        self.assertEqual(client.post(f"/api/short-link/{link['id']}/open").json()["note"], "private-note")
        self.assertEqual(client.get(f"/api/qr.png?s={link['id']}", headers=headers).status_code, 404)

    def test_address_endpoint_saves_valid_address_and_queues_one_reward(self):
        address = "bitcoincash:zqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqweyg7usz"
        client = TestClient(backend.app)
        for _ in range(2):
            response = client.post("/api/cash-address", json={"cash_address": address})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()["cash_address"], address)
        with sqlite3.connect(backend.DB_PATH) as db:
            self.assertEqual(db.execute("SELECT cash_address FROM cash_addresses").fetchall(), [(address,)])
            self.assertEqual(
                db.execute("SELECT cash_address, category FROM token_rewards").fetchall(),
                [(address, "b" * 64)],
            )

    def test_discontinued_bonus_records_are_left_untouched(self):
        with sqlite3.connect(backend.DB_PATH) as db:
            db.execute("CREATE TABLE beer_rewards (cash_address TEXT, signed_tx TEXT)")
            db.execute("INSERT INTO beer_rewards VALUES ('old', 'abcd')")
        backend.init_db()
        with sqlite3.connect(backend.DB_PATH) as db:
            self.assertEqual(db.execute("SELECT * FROM beer_rewards").fetchone(), ("old", "abcd"))
        self.assertEqual(TestClient(backend.app).post("/api/beer-reward", json={}).status_code, 404)

    def test_existing_database_is_migrated_without_queueing_old_addresses(self):
        with sqlite3.connect(backend.DB_PATH) as db:
            db.execute("INSERT INTO cash_addresses (cash_address, network, prefix, address_type) VALUES ('old', 'mainnet', 'bitcoincash', 2)")
            db.execute("DROP TABLE token_rewards")
        backend.init_db()
        with sqlite3.connect(backend.DB_PATH) as db:
            self.assertEqual(db.execute("SELECT cash_address FROM cash_addresses").fetchall(), [("old",)])
            self.assertEqual(db.execute("SELECT * FROM token_rewards").fetchall(), [])
        backend.save_cash_address("new", "bitcoincash", 2)
        with sqlite3.connect(backend.DB_PATH) as db:
            self.assertEqual(db.execute("SELECT cash_address FROM token_rewards").fetchall(), [("new",)])

    def test_worker_recreates_missing_database_and_rejects_replaced_database(self):
        backend.save_cash_address("recipient", "bitcoincash", 2)
        original = backend.DB_PATH.with_name("original.sqlite3")
        backend.DB_PATH.rename(original)
        self.assertFalse(backend.process_one_reward())
        self.assertTrue(backend.DB_PATH.exists())
        replaced = backend.DB_PATH.with_name("replaced.sqlite3")
        backend.DB_PATH.rename(replaced)
        with sqlite3.connect(backend.DB_PATH) as db:
            db.execute("CREATE TABLE token_rewards (cash_address TEXT)")
        with self.assertRaisesRegex(backend.RewardDatabaseError, "changed since startup"):
            backend.process_one_reward()
        with sqlite3.connect(original) as db:
            self.assertEqual(db.execute("SELECT cash_address FROM token_rewards").fetchall(), [("recipient",)])

    def test_missing_reward_table_fails_closed(self):
        with sqlite3.connect(backend.DB_PATH) as db:
            db.execute("DROP TABLE token_rewards")
        with self.assertRaisesRegex(backend.RewardDatabaseError, "lost its token_rewards table"):
            backend.process_one_reward()
        with self.assertRaises(backend.RewardDatabaseError):
            backend.save_cash_address("new", "bitcoincash", 2)
        with sqlite3.connect(backend.DB_PATH) as db:
            self.assertEqual(db.execute("SELECT * FROM cash_addresses").fetchall(), [])

    def test_worker_does_not_log_transaction_details_from_rpc_errors(self):
        tx_detail = "sensitive transaction data"
        with patch.object(backend.reward_stop, "is_set", side_effect=[False, True]), \
             patch.object(backend.reward_wake, "wait"), \
             patch.object(backend, "process_one_reward", side_effect=RuntimeError(tx_detail)), \
             self.assertLogs(backend.logger, level="ERROR") as captured:
            backend.reward_worker()
        self.assertIn("RuntimeError", captured.output[0])
        self.assertNotIn(tx_detail, "\n".join(captured.output))

    def test_payout_logs_actionable_safe_reason_and_queues_retry(self):
        client = TestClient(backend.app)
        with patch.object(backend, "NETCRAFT_REWARD_WAKE_SECRET", "test-secret"), \
             patch.object(backend, "NETCRAFT_MINING_REWARDS_ENABLED", "true"), \
             patch.object(backend, "NETCRAFT_DB_PATH", "unused"), \
             patch.object(backend, "process_one_mining_reward", side_effect=RuntimeError(
                 "No spendable fungible reward tokens are available."
             )), self.assertLogs(backend.logger, level="ERROR") as captured:
            response = client.post("/api/internal/netcraft-mining-reward/7",
                                   headers={"Authorization": "Bearer test-secret"})
        self.assertEqual(response.status_code, 202)
        self.assertIn("No spendable fungible reward tokens are available.", captured.output[0])

    def test_bchn_rpc_logs_error_code_without_transaction_details(self):
        response = type("RpcResponse", (), {
            "json": lambda self: {"error": {"code": -26, "message": "sensitive transaction data"}}
        })()
        with patch.object(backend.httpx, "post", return_value=response), \
             self.assertLogs(backend.logger, level="ERROR") as captured, \
             self.assertRaises(RuntimeError):
            backend.bch_rpc("sendrawtransaction", ["signed transaction"])
        self.assertIn("sendrawtransaction failed (code -26)", captured.output[0])
        self.assertNotIn("sensitive transaction data", captured.output[0])
        self.assertNotIn("signed transaction", captured.output[0])

    def test_wake_requires_shared_secret_and_only_wakes_worker(self):
        client = TestClient(backend.app)
        backend.reward_wake.clear()
        with patch.object(backend, "NETCRAFT_REWARD_WAKE_SECRET", "test-secret"):
            self.assertEqual(client.post("/api/internal/netcraft-reward-wake").status_code, 403)
            self.assertFalse(backend.reward_wake.is_set())
            self.assertEqual(client.post("/api/internal/netcraft-reward-wake",
                headers={"Authorization": "Bearer test-secret"}).status_code, 204)
            self.assertTrue(backend.reward_wake.is_set())
        backend.reward_wake.clear()

    def test_wallet_reward_failure_does_not_block_mining_queue(self):
        with patch.object(backend.reward_stop, "is_set", side_effect=[False, True]), \
             patch.object(backend.reward_wake, "wait"), \
             patch.object(backend, "process_one_reward", side_effect=RuntimeError("unavailable")), \
             patch.object(backend, "process_one_mining_reward", return_value=True) as mining:
            backend.reward_worker()
        mining.assert_called_once()

    def test_donation_address_is_created_once_and_reused(self):
        address = "bitcoincash:zqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqweyg7usz"
        with patch.object(backend, "bch_rpc", return_value=address) as rpc:
            client = TestClient(backend.app)
            self.assertEqual(client.get("/api/donation-address").json(), {"network": "mainnet", "address": address})
            self.assertEqual(client.get("/api/donation-address").json(), {"network": "mainnet", "address": address})
            rpc.assert_called_once_with("getnewaddress", ["cashcraft donations"], wallet=True)

    def test_mining_recipient_uses_minimum_standard_token_dust(self):
        scripts = [
            ("76a914" + "00" * 20 + "88ac", 651),
            ("a914" + "00" * 20 + "87", 645),
            ("aa20" + "00" * 32 + "87", 681),
        ]
        for script, expected in scripts:
            with self.subTest(script=script), \
                 patch.object(backend, "bch_rpc", return_value={"isvalid": True, "scriptPubKey": script}) as rpc:
                self.assertEqual(backend.mining_recipient_dust("recipient"), expected)
                rpc.assert_called_once_with("validateaddress", ["recipient"])
        for invalid in [{"isvalid": False}, {"isvalid": True, "scriptPubKey": "zz"},
                        {"isvalid": True, "scriptPubKey": "6a"}]:
            with self.subTest(invalid=invalid), patch.object(backend, "bch_rpc", return_value=invalid):
                with self.assertRaises(RuntimeError):
                    backend.mining_recipient_dust("recipient")

    def test_unconfirmed_inputs_and_token_change_are_preserved(self):
        calls = []
        token = {"txid": "1" * 64, "vout": 1, "amount": 0.00001, "spendable": True, "confirmations": 0, "tokenData": {"category": "b" * 64, "amount": "5"}}
        nft = {"txid": "2" * 64, "vout": 0, "amount": 1, "spendable": True, "confirmations": 0, "tokenData": {"category": "b" * 64, "amount": "1", "nft": {}}}
        bch = {"txid": "3" * 64, "vout": 0, "amount": 0.0001, "spendable": True, "confirmations": 0}
        def rpc(method, params, *, wallet=False):
            calls.append((method, params, wallet))
            if method == "listunspent":
                return [nft, token, bch]
            if method == "validateaddress":
                return {"isvalid": True, "scriptPubKey": "76a914" + "00" * 20 + "88ac"}
            if method == "getrawchangeaddress":
                return f"change{sum(m == method for m, _, _ in calls)}"
            if method == "createrawtransaction":
                return "unsigned"
            if method == "signrawtransactionwithwallet":
                return {"complete": True, "hex": "01" * 250}
            if method == "decoderawtransaction":
                return {"txid": "4" * 64}
            raise AssertionError(method)
        with patch.object(backend, "bch_rpc", side_effect=rpc):
            signed, txid = backend.build_reward_transaction("recipient", "b" * 64, mining=True)
        self.assertEqual((signed, txid), ("01" * 250, "4" * 64))
        self.assertEqual(calls[0], ("listunspent", [0, 9999999, [], True, {"includeTokens": True}], True))
        inputs, outputs = next(params for method, params, _ in calls if method == "createrawtransaction")
        self.assertEqual([item["txid"] for item in inputs], ["1" * 64, "3" * 64])
        self.assertEqual(outputs[0]["recipient"]["tokenData"]["amount"], "1")
        self.assertEqual(outputs[0]["recipient"]["amount"], "0.00000651")
        self.assertEqual(outputs[1]["change1"]["tokenData"]["amount"], "4")

    def test_ambiguous_broadcast_reuses_persisted_transaction(self):
        backend.save_cash_address("recipient", "bitcoincash", 2)
        with patch.object(backend, "build_reward_transaction", return_value=("abcd", "c" * 64)) as build:
            self.assertTrue(backend.process_one_reward())
            with patch.object(backend, "bch_rpc", side_effect=[RuntimeError("timeout"), RuntimeError("unavailable")]):
                with self.assertRaises(RuntimeError):
                    backend.process_one_reward()
            with sqlite3.connect(backend.DB_PATH) as db:
                self.assertEqual(db.execute("SELECT signed_tx, sent_at FROM token_rewards").fetchone(), ("abcd", None))
            with patch.object(backend, "bch_rpc", side_effect=[RuntimeError("already known"), {"confirmations": 0}, {}]) as rpc:
                self.assertTrue(backend.process_one_reward())
                self.assertEqual(rpc.call_args_list[0].args, ("sendrawtransaction", ["abcd"]))
            self.assertFalse(backend.process_one_reward())
            build.assert_called_once()

    def test_unconfirmed_wallet_transaction_must_still_be_in_mempool(self):
        backend.save_cash_address("recipient", "bitcoincash", 2)
        with patch.object(backend, "build_reward_transaction", return_value=("abcd", "c" * 64)):
            backend.process_one_reward()
        with patch.object(backend, "bch_rpc", side_effect=[RuntimeError("rejected"), {"confirmations": 0}, RuntimeError("not in mempool")]):
            with self.assertRaisesRegex(RuntimeError, "rejected"):
                backend.process_one_reward()
        with sqlite3.connect(backend.DB_PATH) as db:
            self.assertIsNone(db.execute("SELECT sent_at FROM token_rewards").fetchone()[0])


if __name__ == "__main__":
    unittest.main()
