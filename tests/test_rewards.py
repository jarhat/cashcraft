import importlib.util
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

os.environ.update({
    "BCH_NETWORK": "mainnet",
    "BCH_RPC_USER": "test",
    "BCH_RPC_PASSWORD": "test",
    "BCH_ALLOWED_TOKEN_CATEGORIES": "a" * 64,
    "BCH_REWARD_CATEGORY": "b" * 64,
    "BCH_REQUIRED_CONFIRMATIONS": "0",
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

    def test_only_new_addresses_are_queued_and_proof_rollback_is_atomic(self):
        with sqlite3.connect(backend.DB_PATH) as db:
            db.execute("INSERT INTO cash_addresses (cash_address, network, prefix, address_type) VALUES ('old', 'mainnet', 'bitcoincash', 2)")
        backend.save_cash_address("old", "bitcoincash", 2)
        backend.save_cash_address("new", "bitcoincash", 2)
        backend.save_cash_address("new", "bitcoincash", 2)
        backend.save_cash_address_with_proof("proof", "bitcoincash", 2, "f" * 64)
        with self.assertRaises(sqlite3.IntegrityError):
            backend.save_cash_address_with_proof("failed", "bitcoincash", 2, "f" * 64)
        with sqlite3.connect(backend.DB_PATH) as db:
            rows = db.execute("SELECT cash_address, category FROM token_rewards ORDER BY cash_address").fetchall()
            self.assertEqual(rows, [("new", "b" * 64), ("proof", "b" * 64)])
            self.assertIsNone(db.execute("SELECT 1 FROM cash_addresses WHERE cash_address = 'failed'").fetchone())

    def test_unconfirmed_inputs_and_token_change_are_preserved(self):
        calls = []
        token = {"txid": "1" * 64, "vout": 1, "amount": 0.00001, "spendable": True, "confirmations": 0, "tokenData": {"category": "b" * 64, "amount": "5"}}
        nft = {"txid": "2" * 64, "vout": 0, "amount": 1, "spendable": True, "confirmations": 0, "tokenData": {"category": "b" * 64, "amount": "1", "nft": {}}}
        bch = {"txid": "3" * 64, "vout": 0, "amount": 0.0001, "spendable": True, "confirmations": 0}
        def rpc(method, params, *, wallet=False):
            calls.append((method, params, wallet))
            if method == "listunspent":
                return [nft, token, bch]
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
            signed, txid = backend.build_reward_transaction("recipient", "b" * 64)
        self.assertEqual((signed, txid), ("01" * 250, "4" * 64))
        self.assertEqual(calls[0], ("listunspent", [0, 9999999, [], True, {"includeTokens": True}], True))
        inputs, outputs = next(params for method, params, _ in calls if method == "createrawtransaction")
        self.assertEqual([item["txid"] for item in inputs], ["1" * 64, "3" * 64])
        self.assertEqual(outputs[0]["recipient"]["tokenData"]["amount"], "1")
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

    def test_unconfirmed_proof_compares_locking_script(self):
        txid = "f" * 64
        tx = {
            "txid": txid, "confirmations": 0,
            "vin": [{"scriptPubKey": {"hex": "76abcd"}}],
            "vout": [{"tokenData": {"category": "a" * 64, "amount": "1"}}],
        }
        with patch.object(backend, "BCH_ALLOWED_SENDER", "bitcoincash:sender"), \
             patch.object(backend, "bch_rpc", side_effect=[{"isvalid": True, "scriptPubKey": "76abcd"}, tx]):
            self.assertEqual(backend.verify_confirmed_payment(txid)["confirmations"], 0)

    def test_proof_configuration_is_not_required_for_address_rewards(self):
        backend.save_cash_address("no-proof", "bitcoincash", 2)
        with sqlite3.connect(backend.DB_PATH) as db:
            self.assertEqual(
                db.execute(
                    "SELECT category FROM token_rewards WHERE cash_address = 'no-proof'"
                ).fetchone(),
                ("b" * 64,),
            )
        with patch.object(backend, "BCH_ALLOWED_SENDER", ""), \
             patch.object(backend, "bch_rpc") as rpc:
            with self.assertRaisesRegex(RuntimeError, "BCH_ALLOWED_SENDER"):
                backend.verify_confirmed_payment("f" * 64)
            rpc.assert_not_called()

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
