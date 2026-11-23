"""Run against a fresh isolated BCHN regtest container; never use a shared wallet."""

import json
from pathlib import Path
import subprocess
import sys
import time

from backend.challenge_vault import ChallengeVault, Outpoint


def run(container, artifact):
    network = subprocess.check_output(
        ["docker", "inspect", "--format", "{{.HostConfig.NetworkMode}}", container], text=True
    ).strip()
    if network != "none":
        raise RuntimeError("Requires a Docker container with --network none")

    def rpc(method, params, *, wallet=False):
        args = [json.dumps(p) if not isinstance(p, str) else p for p in params]
        command = ["docker", "exec", container, "bitcoin-cli", "-regtest"]
        if wallet:
            command.append("-rpcwallet=challenge-test")
        result = subprocess.run([*command, method, *args], check=True, capture_output=True, text=True)
        try:
            return json.loads(result.stdout)
        except json.JSONDecodeError:
            return result.stdout.strip()

    def check(condition, message):
        if not condition:
            raise AssertionError(message)

    def accepted(tx):
        return rpc("testmempoolaccept", [[tx]])[0]["allowed"]

    info = rpc("getblockchaininfo", [])
    check(info["chain"] == "regtest" and info["blocks"] == 0, "Requires a fresh regtest chain")
    rpc("createwallet", ["challenge-test"])
    a, b, referee, miner = [rpc("getnewaddress", [], wallet=True) for _ in range(4)]
    rpc("generatetoaddress", [101, miner])
    vault = ChallengeVault("ab" * 32, a, b, referee, 50_000, int(time.time()) + 7_200, "bchreg", artifact)

    def fund(address, bch):
        txid = rpc("sendtoaddress", [address, bch], wallet=True)
        decoded = rpc("gettransaction", [txid], wallet=True)["hex"]
        output = next(v for v in rpc("decoderawtransaction", [decoded])["vout"]
                      if v["scriptPubKey"].get("addresses") == [address])
        return Outpoint(txid, output["n"])

    funds = vault.funding()
    pa = fund(funds["a"]["address"], 0.0005)
    pb = fund(funds["b"]["address"], 0.0005)
    anchor = fund(referee, 0.0002)
    other_vault = ChallengeVault("ff" * 32, a, b, referee, 50_000, vault.refund_after, "bchreg", artifact)
    other_b = fund(other_vault.funding()["b"]["address"], 0.0005)
    rpc("generatetoaddress", [6, miner])

    unsigned = vault.unsigned_settlement("a", pa, pb, anchor, 20_000)
    check(not accepted(unsigned), "Unsigned referee input must fail")
    for winner in ("a", "b"):
        signed = vault.sign_settlement(rpc, winner, pa, pb, anchor)
        check(accepted(signed), f"Valid winner {winner} payout rejected")
    cross = vault.unsigned_settlement("a", pa, other_b, anchor, 20_000)
    cross = cross.replace(vault.redeem_scripts()[1].hex(), other_vault.redeem_scripts()[1].hex(), 1)
    cross = rpc("signrawtransactionwithwallet", [cross, [], "ALL|FORKID"], wallet=True)
    check(not accepted(cross["hex"]), "Mixed-challenge funding must fail")
    payout_script = rpc("validateaddress", [a])["scriptPubKey"]
    third_party = rpc("validateaddress", [miner])["scriptPubKey"]
    payout_tail = payout_script + (18_000).to_bytes(8, "little").hex() + "19"
    check(payout_tail in unsigned, "Expected fixed payout followed by referee change")
    redirected = unsigned.replace(payout_tail, third_party + payout_tail[len(payout_script):], 1)
    redirected = rpc("signrawtransactionwithwallet", [redirected, [], "ALL|FORKID"], wallet=True)
    check(not accepted(redirected["hex"]), "Referee signature cannot redirect stake to a third party")
    swapped = vault.refund_transaction("b", pa, 50_000)
    a_refund = vault.refund_transaction("a", pa, 50_000)
    b_refund = vault.refund_transaction("b", pb, 50_000)
    check(not accepted(a_refund), "Early refund must fail")
    rpc("setmocktime", [vault.refund_after + 1])
    rpc("generatetoaddress", [11, miner])
    check(accepted(a_refund) and accepted(b_refund), "Mature independent refunds must succeed")
    check(not accepted(swapped), "Refund cannot substitute the other player's covenant")
    check(accepted(signed), "A previously signed settlement can still race a mature refund")
    try:
        vault.sign_settlement(rpc, "a", pa, pb, anchor)
    except RuntimeError as exc:
        check("window is closed" in str(exc), "Expected signing cutoff")
    else:
        raise AssertionError("Signer must reject late outcomes")
    print("ChallengeVault: BCHN accepted both outcomes and mature refunds; rejected invalid spends.")


if __name__ == "__main__":
    run(sys.argv[1], Path(sys.argv[2]))
