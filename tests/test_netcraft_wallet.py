import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient
from test_rewards import backend


class NetcraftWalletTests(unittest.TestCase):
    def test_verifier_requires_internal_auth_and_distinguishes_admin(self):
        address = "bitcoincash:qppyysjzgfpyysjzgfpyysjzgfpyysjzggkqscq4cy"
        token = "bitcoincash:zppyysjzgfpyysjzgfpyysjzgfpyysjzgg32rxwn8h"
        proof = {"address": token, "nonce": "ba" * 32, "signature": "A" * 87 + "="}
        client = TestClient(backend.app)
        path = "/api/internal/netcraft-admin-proof"
        headers = {"Authorization": "Bearer test-secret"}
        with patch.object(backend, "NETCRAFT_REWARD_WAKE_SECRET", "test-secret"), \
             patch.object(backend, "bch_rpc", return_value=True) as rpc, \
             patch.dict("os.environ", {"NETCRAFT_ADMIN_BCH_ADDRESS": address}):
            self.assertEqual(client.post(path, json=proof).status_code, 403)
            rpc.assert_not_called()
            self.assertEqual(client.post(path, headers=headers, json=proof).status_code, 204)
            rpc.assert_called_once_with("verifymessage", [
                address, proof["signature"], f"CashCraft wallet login v1: {proof['nonce']}",
            ])
            with patch.dict("os.environ", {"NETCRAFT_ADMIN_BCH_ADDRESS": token}):
                self.assertEqual(client.post(path, headers=headers, json=proof).status_code, 204)
            with patch.dict("os.environ", {"NETCRAFT_ADMIN_BCH_ADDRESS": ""}):
                self.assertEqual(client.post(path, headers=headers, json=proof).status_code, 202)
            rpc.return_value = False
            self.assertEqual(client.post(path, headers=headers, json=proof).status_code, 403)
