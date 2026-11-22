"""Offline ChallengeVault transaction construction; BCHN signing is regtest-only."""

from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from hashlib import sha256
import json
from pathlib import Path
import re
import time

REFUND_FEE_SATS = 1_000
SETTLEMENT_FEE_SATS = 2_000
DUST_SATS = 546
MAX_SATS = 21_000_000 * 100_000_000
SIGNING_MARGIN_SECONDS = 3_600
ARTIFACT_PATH = Path("/app/artifacts/ChallengeVault.json")
PREFIXES = {"bitcoincash", "bchtest", "bchreg"}
CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
GENERATORS = (0x98F2BC8E61, 0x79B76D99E2, 0xF33E5FB3C4, 0xAE2EABE2A8, 0x1E4F43E470)
HEX32 = re.compile(r"[0-9a-fA-F]{64}")


def _polymod(prefix, values):
    state = 1
    for digit in [*(ord(c) & 31 for c in prefix), 0, *values]:
        top = state >> 35
        state = ((state & 0x07FFFFFFFF) << 5) ^ digit
        for index, generator in enumerate(GENERATORS):
            if (top >> index) & 1:
                state ^= generator
    return state ^ 1


def _convert(values, source, target, *, pad):
    bits = accumulator = 0
    result = []
    for value in values:
        accumulator = (accumulator << source) | value
        bits += source
        while bits >= target:
            bits -= target
            result.append((accumulator >> bits) & ((1 << target) - 1))
        accumulator &= (1 << bits) - 1
    if pad and bits:
        result.append(accumulator << (target - bits))
    elif bits >= source or accumulator:
        raise ValueError("Invalid CashAddr padding")
    return result


def _pkh(address, prefix):
    if not isinstance(address, str) or address not in (address.lower(), address.upper()):
        raise ValueError("Expected a non-mixed-case P2PKH CashAddr")
    actual_prefix, _, text = address.lower().partition(":")
    if actual_prefix != prefix or len(text) != 42:
        raise ValueError("Expected a prefixed P2PKH CashAddr for this chain")
    values = [CHARSET.index(c) for c in text]
    payload = bytes(_convert(values[:-8], 5, 8, pad=False))
    if _polymod(prefix, values) or len(payload) != 21 or payload[0] not in (0, 16):
        raise ValueError("Expected a valid P2PKH CashAddr")
    return payload[1:]


def _address(prefix, version, payload):
    values = _convert(bytes([version]) + payload, 8, 5, pad=True)
    checksum = _polymod(prefix, values + [0] * 8)
    return prefix + ":" + "".join(CHARSET[v] for v in values + [
        (checksum >> shift) & 31 for shift in range(35, -1, -5)
    ])


def _p2pkh(pkh):
    return b"\x76\xa9\x14" + pkh + b"\x88\xac"


def _hash256(data):
    return sha256(sha256(data).digest()).digest()


def _push(data):
    if not data:
        return b"\x00"
    if len(data) == 1 and 1 <= data[0] <= 16:
        return bytes([0x50 + data[0]])
    if len(data) <= 75:
        return bytes([len(data)]) + data
    if len(data) <= 255:
        return b"\x4c" + bytes([len(data)]) + data
    return b"\x4d" + len(data).to_bytes(2, "little") + data


def _number(n):
    encoded = n.to_bytes((n.bit_length() + 7) // 8, "little")
    return encoded + b"\x00" if encoded and encoded[-1] & 0x80 else encoded


def _uint32(n):
    return n.to_bytes(4, "little")


def _varbytes(data):
    length = len(data)
    return (bytes([length]) if length < 253 else b"\xfd" + length.to_bytes(2, "little")) + data


def _amount(satoshis):
    if type(satoshis) is not int or not 0 <= satoshis <= MAX_SATS:
        raise ValueError("Invalid BCH amount in satoshis")
    return satoshis


@dataclass(frozen=True)
class Outpoint:
    txid: str
    vout: int

    def __post_init__(self):
        if not isinstance(self.txid, str) or not HEX32.fullmatch(self.txid):
            raise ValueError("Expected a 32-byte hex transaction ID")
        if type(self.vout) is not int or not 0 <= self.vout <= 0xFFFFFFFF:
            raise ValueError("Invalid output index")
        object.__setattr__(self, "txid", self.txid.lower())


def _transaction(inputs, outputs, locktime=0):
    sequence = _uint32(0xFFFFFFFE if locktime else 0xFFFFFFFF)
    tx = _uint32(2) + bytes([len(inputs)])
    for outpoint, unlocking in inputs:
        tx += bytes.fromhex(outpoint.txid)[::-1] + _uint32(outpoint.vout) + _varbytes(unlocking) + sequence
    tx += bytes([len(outputs)])
    for satoshis, script in outputs:
        tx += _amount(satoshis).to_bytes(8, "little") + _varbytes(script)
    return (tx + _uint32(locktime)).hex()


@dataclass(frozen=True, slots=True)
class ChallengeVault:
    challenge_id: str
    player_a: str
    player_b: str
    referee: str
    stake_sats: int
    refund_after: int
    prefix: str
    artifact_path: Path = ARTIFACT_PATH

    def __post_init__(self):
        if not isinstance(self.challenge_id, str) or not HEX32.fullmatch(self.challenge_id):
            raise ValueError("Expected a nonzero 32-byte hex challenge ID")
        if int(self.challenge_id, 16) == 0:
            raise ValueError("Expected a nonzero 32-byte hex challenge ID")
        if self.prefix not in PREFIXES:
            raise ValueError("Unsupported CashAddr prefix")
        if len(set(self._pkhs())) != 3:
            raise ValueError("Players and referee require three distinct P2PKH scripts")
        if not DUST_SATS + REFUND_FEE_SATS <= _amount(self.stake_sats) <= MAX_SATS // 2:
            raise ValueError("Stake is outside supported limits")
        if type(self.refund_after) is not int or not 500_000_000 <= self.refund_after <= 0xFFFFFFFF:
            raise ValueError("Refund deadline must be a uint32 Unix timestamp")

    def _pkhs(self):
        return tuple(_pkh(address, self.prefix) for address in (self.player_a, self.player_b, self.referee))

    def redeem_scripts(self):
        """Return the pinned CashScript redeem bytecode, ordered A then B."""
        artifact = json.loads(self.artifact_path.read_text(encoding="utf-8"))
        if (
            artifact["contractName"] != "ChallengeVault"
            or artifact["compiler"]["version"] != "0.14.0"
            or artifact["abi"] != [{"name": "settle", "inputs": []}, {"name": "refund", "inputs": []}]
        ):
            raise ValueError("Unexpected ChallengeVault artifact")
        args = (
            bytes.fromhex(self.challenge_id), *self._pkhs(),
            _number(self.stake_sats), _number(self.refund_after),
        )
        template = b"".join(_push(arg) for arg in reversed(args)) + bytes.fromhex(artifact["debug"]["bytecode"])
        return b"\x00" + template, b"\x51" + template

    def funding(self):
        """Return offline funding terms; this does not discover or accept deposits."""
        return {
            role: {
                "address": _address(self.prefix, 11, digest),
                "locking_bytecode": (b"\xaa\x20" + digest + b"\x87").hex(),
                "stake_sats": self.stake_sats,
            }
            for role, script in zip(("a", "b"), self.redeem_scripts())
            for digest in [_hash256(script)]
        }

    def refund_transaction(self, role, outpoint, input_sats):
        """Build a permissionless refund; only the fixed owner's output is allowed."""
        if role not in ("a", "b"):
            raise ValueError("Expected role 'a' or 'b'")
        index = int(role == "b")
        if _amount(input_sats) < REFUND_FEE_SATS + DUST_SATS:
            raise ValueError("Deposit is too small to refund")
        unlock = b"\x51" + _push(self.redeem_scripts()[index])
        return _transaction(
            [(outpoint, unlock)],
            [(input_sats - REFUND_FEE_SATS, _p2pkh(self._pkhs()[index]))],
            locktime=self.refund_after,
        )

    def unsigned_settlement(self, winner, stake_a, stake_b, anchor, anchor_sats):
        """Build an exact payout; only the third input still requires a signature."""
        if winner not in ("a", "b"):
            raise ValueError("Expected winner 'a' or 'b'")
        if len({stake_a, stake_b, anchor}) != 3:
            raise ValueError("Settlement requires three distinct outpoints")
        if not SETTLEMENT_FEE_SATS + DUST_SATS <= _amount(anchor_sats) <= MAX_SATS - self.stake_sats * 2:
            raise ValueError("Referee anchor value is outside supported limits")
        redeem_a, redeem_b = self.redeem_scripts()
        pkhs = self._pkhs()
        return _transaction(
            [(stake_a, b"\x00" + _push(redeem_a)), (stake_b, b"\x00" + _push(redeem_b)), (anchor, b"")],
            [(2 * self.stake_sats, _p2pkh(pkhs[int(winner == "b")])),
             (anchor_sats - SETTLEMENT_FEE_SATS, _p2pkh(pkhs[2]))],
        )

    def sign_settlement(self, rpc, winner, stake_a, stake_b, anchor, *, min_confirmations=6):
        """Sign and test acceptance against a local BCHN regtest wallet; never broadcast."""
        if type(min_confirmations) is not int or min_confirmations < 1:
            raise ValueError("Expected a positive confirmation threshold")

        def check_chain_and_deadline():
            chain = rpc("getblockchaininfo", [])
            if self.prefix != "bchreg" or chain.get("chain") != "regtest":
                raise RuntimeError("Challenge settlement signing is restricted to regtest")
            mtp = chain.get("mediantime")
            if type(mtp) is not int or max(mtp, time.time()) + SIGNING_MARGIN_SECONDS >= self.refund_after:
                raise RuntimeError("Settlement signing window is closed")

        check_chain_and_deadline()
        funds = self.funding()
        referee_script = _p2pkh(self._pkhs()[2]).hex()

        def verified_value(outpoint, script):
            entry = rpc("gettxout", [outpoint.txid, outpoint.vout, True])
            if (
                not isinstance(entry, dict)
                or (entry.get("scriptPubKey") or {}).get("hex") != script
                or "tokenData" in entry
                or type(entry.get("confirmations")) is not int
                or entry["confirmations"] < min_confirmations
            ):
                raise RuntimeError("Expected an available, confirmed, BCH-only output with the fixed script")
            try:
                sats = Decimal(str(entry["value"])) * 100_000_000
                if not sats.is_finite() or sats != sats.to_integral_value():
                    raise ValueError("Nonintegral satoshi amount")
                return _amount(int(sats))
            except (InvalidOperation, KeyError, ValueError, OverflowError) as exc:
                raise RuntimeError("Invalid BCHN output value") from exc

        for role, outpoint in (("a", stake_a), ("b", stake_b)):
            if verified_value(outpoint, funds[role]["locking_bytecode"]) != self.stake_sats:
                raise RuntimeError("Funding output does not match the exact stake")
        anchor_sats = verified_value(anchor, referee_script)
        unsigned = self.unsigned_settlement(winner, stake_a, stake_b, anchor, anchor_sats)
        check_chain_and_deadline()
        signed = rpc("signrawtransactionwithwallet", [unsigned, [], "ALL|FORKID"], wallet=True)
        if not isinstance(signed, dict) or signed.get("complete") is not True or not isinstance(signed.get("hex"), str):
            raise RuntimeError("BCHN did not complete the challenge settlement")
        acceptance = rpc("testmempoolaccept", [[signed["hex"]]])
        if not isinstance(acceptance, list) or len(acceptance) != 1 or not isinstance(acceptance[0], dict):
            raise RuntimeError("BCHN rejected the settlement in testmempoolaccept")
        if acceptance[0].get("allowed") is not True:
            raise RuntimeError(f"BCHN rejected the settlement: {acceptance[0].get('reject-reason', 'unknown')}")
        return signed["hex"]
