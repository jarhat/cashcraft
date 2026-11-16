import os
import re
import sqlite3
import logging
import threading
from decimal import Decimal
from pathlib import Path
from urllib.parse import quote

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

NETWORK = os.getenv("BCH_NETWORK", "chipnet").strip().lower()

NETWORK_PREFIXES = {
    "mainnet": {"bitcoincash"},
    "chipnet": {"bchtest"},
}

if NETWORK not in NETWORK_PREFIXES:
    raise RuntimeError(
        f"Unsupported BCH_NETWORK={NETWORK!r}; use 'chipnet' or 'mainnet'."
    )
if NETWORK != "mainnet":
    raise RuntimeError(
        "This BCHN Docker configuration is mainnet-only; "
        "do not run it with BCH_NETWORK=chipnet."
    )

BCH_RPC_URL = os.getenv("BCH_RPC_URL", "http://bchn:8332/")
BCH_RPC_USER = os.getenv("BCH_RPC_USER")
BCH_RPC_PASSWORD = os.getenv("BCH_RPC_PASSWORD")
BCH_ALLOWED_SENDER = os.getenv("BCH_ALLOWED_SENDER", "").strip().lower()
BCH_WALLET = os.getenv("BCH_WALLET", "token-sender").strip()
BCH_REWARD_CATEGORY = os.getenv("BCH_REWARD_CATEGORY", "").strip().lower()

CATEGORY_RE = re.compile(r"^[0-9a-fA-F]{64}$")
TXID_RE = re.compile(r"^[0-9a-fA-F]{64}$")

try:
    BCH_REQUIRED_CONFIRMATIONS = int(
        os.getenv("BCH_REQUIRED_CONFIRMATIONS", "0")
    )
except ValueError as exc:
    raise RuntimeError("BCH_REQUIRED_CONFIRMATIONS must be an integer.") from exc

if BCH_REQUIRED_CONFIRMATIONS < 0:
    raise RuntimeError("BCH_REQUIRED_CONFIRMATIONS must be at least 0.")

_raw_categories = os.getenv("BCH_ALLOWED_TOKEN_CATEGORIES", "")
BCH_ALLOWED_TOKEN_CATEGORIES = {
    item.strip().lower()
    for item in _raw_categories.split(",")
    if item.strip()
}

if not BCH_RPC_USER or not BCH_RPC_PASSWORD:
    raise RuntimeError("Set BCH_RPC_USER and BCH_RPC_PASSWORD.")

if not BCH_WALLET:
    raise RuntimeError("Set BCH_WALLET.")

if not CATEGORY_RE.fullmatch(BCH_REWARD_CATEGORY):
    raise RuntimeError("Set BCH_REWARD_CATEGORY to a 64-character category ID.")

if not BCH_ALLOWED_TOKEN_CATEGORIES:
    raise RuntimeError("Set BCH_ALLOWED_TOKEN_CATEGORIES.")

if any(not CATEGORY_RE.fullmatch(c) for c in BCH_ALLOWED_TOKEN_CATEGORIES):
    raise RuntimeError(
        "Each BCH_ALLOWED_TOKEN_CATEGORIES entry must be 64 hex characters."
    )


DB_PATH = Path(os.getenv("CASHADDR_DB_PATH", "/data/cash-addresses.sqlite3"))

_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
_CHARSET_MAP = {char: index for index, char in enumerate(_CHARSET)}
_GENERATORS = (
    0x98F2BC8E61,
    0x79B76D99E2,
    0xF33E5FB3C4,
    0xAE2EABE2A8,
    0x1E4F43E470,
)
_HASH_LENGTHS = (20, 24, 28, 32, 40, 48, 56, 64)

app = FastAPI(title="CashToken-aware CashAddr receiver")
logger = logging.getLogger(__name__)
reward_stop = threading.Event()
reward_thread = None

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://demo.ctf.cash",
    ],
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)


class CashAddressProofRequest(BaseModel):
    cash_address: str = Field(min_length=1, max_length=120)
    txid: str = Field(min_length=64, max_length=64)


class CashAddressRequest(BaseModel):
    cash_address: str = Field(min_length=1, max_length=120)


def init_db() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)

    with sqlite3.connect(DB_PATH) as db:
        db.execute("""
            CREATE TABLE IF NOT EXISTS cash_addresses (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                cash_address TEXT NOT NULL UNIQUE,
                network TEXT NOT NULL,
                prefix TEXT NOT NULL,
                address_type INTEGER NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
        """)
        db.execute("""
            CREATE TABLE IF NOT EXISTS token_rewards (
                cash_address TEXT PRIMARY KEY,
                category TEXT NOT NULL,
                signed_tx TEXT,
                txid TEXT,
                sent_at TEXT,
                FOREIGN KEY (cash_address) REFERENCES cash_addresses(cash_address)
            )
        """)


@app.on_event("startup")
def startup() -> None:
    global reward_thread
    init_db()
    reward_stop.clear()
    reward_thread = threading.Thread(target=reward_worker, daemon=True)
    reward_thread.start()


@app.on_event("shutdown")
def shutdown() -> None:
    reward_stop.set()
    if reward_thread:
        reward_thread.join(timeout=35)

def _insert_cash_address(
    db: sqlite3.Connection,
    address: str,
    prefix: str,
    address_type: int,
) -> None:
    cursor = db.execute(
        """
        INSERT INTO cash_addresses
            (cash_address, network, prefix, address_type)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(cash_address) DO NOTHING
        """,
        (address, NETWORK, prefix, address_type),
    )
    if cursor.rowcount:
        db.execute(
            "INSERT INTO token_rewards (cash_address, category) VALUES (?, ?)",
            (address, BCH_REWARD_CATEGORY),
        )


def save_cash_address(address: str, prefix: str, address_type: int) -> None:
    with sqlite3.connect(DB_PATH, timeout=10) as db:
        _insert_cash_address(db, address, prefix, address_type)


def save_cash_address_with_proof(
    address: str,
    prefix: str,
    address_type: int,
    txid: str,
) -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)

    with sqlite3.connect(DB_PATH, timeout=10) as db:
        db.execute("BEGIN IMMEDIATE")

        _insert_cash_address(db, address, prefix, address_type)

        db.execute(
            """
            CREATE TABLE IF NOT EXISTS cash_address_proofs (
                txid TEXT PRIMARY KEY,
                cash_address TEXT NOT NULL UNIQUE,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (cash_address)
                    REFERENCES cash_addresses(cash_address)
            )
            """
        )

        db.execute(
            """
            INSERT INTO cash_address_proofs (txid, cash_address)
            VALUES (?, ?)
            """,
            (txid.lower(), address),
        )


def _prefix_expand(prefix: str) -> list[int]:
    return [ord(char) & 0x1F for char in prefix] + [0]


def _polymod(values: list[int]) -> int:
    checksum = 1

    for value in values:
        top = checksum >> 35
        checksum = ((checksum & 0x07FFFFFFFF) << 5) ^ value

        for bit, generator in enumerate(_GENERATORS):
            if (top >> bit) & 1:
                checksum ^= generator

    return checksum ^ 1


def _convert_5bit_to_8bit(values: list[int]) -> bytes:
    accumulator = 0
    bit_count = 0
    result = bytearray()

    for value in values:
        if not 0 <= value <= 31:
            raise ValueError("Invalid CashAddr data value.")

        accumulator = (accumulator << 5) | value
        bit_count += 5

        while bit_count >= 8:
            bit_count -= 8
            result.append((accumulator >> bit_count) & 0xFF)

    # CashAddr payload conversion uses no padding; leftover bits must be zero.
    if bit_count >= 5 or (
        bit_count > 0 and ((accumulator << (8 - bit_count)) & 0xFF) != 0
    ):
        raise ValueError("Invalid CashAddr padding.")

    return bytes(result)


def validate_token_aware_cashaddr(value: str) -> tuple[str, str, int]:
    address = value.strip()

    if not address or (address.lower() != address and address.upper() != address):
        raise ValueError("CashAddr must not mix uppercase and lowercase.")

    address = address.lower()

    if address.count(":") != 1:
        raise ValueError("Use a prefixed CashAddr.")

    prefix, encoded_payload = address.split(":", 1)

    if not prefix or not encoded_payload:
        raise ValueError("CashAddr prefix or payload is empty.")

    if prefix not in NETWORK_PREFIXES[NETWORK]:
        expected = ", ".join(sorted(NETWORK_PREFIXES[NETWORK]))
        raise ValueError(
            f"Address prefix does not match {NETWORK}; expected {expected}."
        )

    try:
        values = [_CHARSET_MAP[char] for char in encoded_payload]
    except KeyError as exc:
        raise ValueError("CashAddr contains an invalid character.") from exc

    if len(values) < 9:
        raise ValueError("CashAddr payload is too short.")

    # With this polymod implementation, a valid full CashAddr has result 0.
    if _polymod(_prefix_expand(prefix) + values) != 0:
        raise ValueError("Invalid CashAddr checksum.")

    payload = _convert_5bit_to_8bit(values[:-8])

    if not payload:
        raise ValueError("CashAddr payload is empty.")

    version = payload[0]

    if version & 0x80:
        raise ValueError("Invalid CashAddr version byte.")

    address_type = version >> 3
    size_index = version & 0x07

    if size_index >= len(_HASH_LENGTHS):
        raise ValueError("Invalid CashAddr hash-size indicator.")

    expected_hash_length = _HASH_LENGTHS[size_index]
    hash_payload = payload[1:]

    if len(hash_payload) != expected_hash_length:
        raise ValueError("CashAddr payload length does not match its version.")

    # CashToken-aware address types: 2 = P2PKH, 3 = P2SH.
    if address_type not in {2, 3}:
        raise ValueError(
            "Address is valid CashAddr but is not CashToken-aware. "
            "Use a token-aware P2PKH or P2SH address."
        )

    return address, prefix, address_type


@app.get("/health")
def health() -> dict[str, str]:
    return {
        "status": "ok",
        "network": NETWORK,
    }


@app.get("/api/token-reward")
def token_reward() -> dict[str, str]:
    return {"category": BCH_REWARD_CATEGORY}


@app.post("/api/cash-address")
def receive_cash_address(
    request: CashAddressRequest,
) -> dict[str, str | int]:
    try:
        address, prefix, address_type = validate_token_aware_cashaddr(
            request.cash_address
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    try:
        save_cash_address(address, prefix, address_type)
    except sqlite3.Error as exc:
        raise HTTPException(
            status_code=500,
            detail="Could not save cash address.",
        ) from exc

    return {
        "network": NETWORK,
        "cash_address": address,
        "prefix": prefix,
        "token_aware": True,
        "address_type": address_type,
    }

@app.post("/api/tx-proof")
def receive_cash_address_with_proof(
    request: CashAddressProofRequest,
) -> dict:
    txid = request.txid.strip().lower()

    if not TXID_RE.fullmatch(txid):
        raise HTTPException(status_code=422, detail="Invalid transaction ID.")

    try:
        address, prefix, address_type = validate_token_aware_cashaddr(
            request.cash_address
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    try:
        payment_proof = verify_confirmed_payment(txid)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    try:
        save_cash_address_with_proof(
            address=address,
            prefix=prefix,
            address_type=address_type,
            txid=txid,
        )
    except sqlite3.IntegrityError as exc:
        raise HTTPException(
            status_code=409,
            detail="This transaction ID or cash address has already been used.",
        ) from exc
    except sqlite3.Error as exc:
        raise HTTPException(
            status_code=500,
            detail="Could not save the cash address and proof.",
        ) from exc

    return {
        "network": NETWORK,
        "cash_address": address,
        "prefix": prefix,
        "token_aware": True,
        "proof": payment_proof,
    }

def bch_rpc(method: str, params: list, *, wallet: bool = False):
    url = BCH_RPC_URL
    if wallet:
        url = url.rstrip("/") + "/wallet/" + quote(BCH_WALLET, safe="")
    try:
        response = httpx.post(
            url,
            auth=(BCH_RPC_USER, BCH_RPC_PASSWORD),
            json={
                "jsonrpc": "1.0",
                "id": "cash-address-proof",
                "method": method,
                "params": params,
            },
            timeout=30.0,
        )
        payload = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise RuntimeError("Could not communicate with BCHN.") from exc

    if not isinstance(payload, dict):
        raise RuntimeError("BCHN returned an invalid RPC response.")
    if payload.get("error"):
        rpc_error = payload["error"]
        message = (
            rpc_error.get("message", "BCHN RPC error")
            if isinstance(rpc_error, dict)
            else str(rpc_error)
        )
        raise RuntimeError(message)

    try:
        response.raise_for_status()
    except httpx.HTTPError as exc:
        raise RuntimeError("BCHN returned an HTTP error.") from exc
    return payload.get("result")


def _satoshis(amount) -> int:
    value = Decimal(str(amount)) * 100_000_000
    if value != value.to_integral_value() or value < 0:
        raise RuntimeError("BCHN returned an invalid UTXO amount.")
    return int(value)


def _bch_amount(satoshis: int) -> str:
    return f"{satoshis // 100_000_000}.{satoshis % 100_000_000:08d}"


def build_reward_transaction(address: str, category: str) -> tuple[str, str]:
    utxos = bch_rpc(
        "listunspent", [0, 9999999, [], True, {"includeTokens": True}], wallet=True
    )
    if not isinstance(utxos, list):
        raise RuntimeError("BCHN returned an invalid UTXO list.")
    spendable = [u for u in utxos if u.get("spendable") and u.get("confirmations", 0) >= 0]
    token_inputs = [
        u for u in spendable
        if isinstance(u.get("tokenData"), dict)
        and u["tokenData"].get("category", "").lower() == category
        and "nft" not in u["tokenData"]
        and int(u["tokenData"].get("amount", "0")) > 0
    ]
    if not token_inputs:
        raise RuntimeError("No spendable fungible reward tokens are available.")
    token_input = min(token_inputs, key=lambda u: int(u["tokenData"]["amount"]))
    token_amount = int(token_input["tokenData"]["amount"])
    inputs = [token_input]
    total = _satoshis(token_input["amount"])
    token_change = token_amount - 1
    output_value = 1000 * (1 + bool(token_change))
    bch_inputs = [u for u in spendable if "tokenData" not in u]
    for utxo in bch_inputs:
        if total >= output_value + 1000 + 200 * len(inputs):
            break
        inputs.append(utxo)
        total += _satoshis(utxo["amount"])
    fee = 1000 + 200 * len(inputs)
    if total < output_value + fee:
        raise RuntimeError("Insufficient BCH for the reward transaction.")

    outputs = [{
        address: {"amount": _bch_amount(1000), "tokenData": {"category": category, "amount": "1"}}
    }]
    if token_change:
        change_address = bch_rpc("getrawchangeaddress", [], wallet=True)
        outputs.append({
            change_address: {
                "amount": _bch_amount(1000),
                "tokenData": {"category": category, "amount": str(token_change)},
            }
        })
    change = total - output_value - fee
    if change >= 1000:
        change_address = bch_rpc("getrawchangeaddress", [], wallet=True)
        outputs.append({change_address: _bch_amount(change)})
    else:
        fee += change

    raw = bch_rpc("createrawtransaction", [[
        {"txid": u["txid"], "vout": u["vout"]} for u in inputs
    ], outputs])
    signed = bch_rpc("signrawtransactionwithwallet", [raw], wallet=True)
    if not isinstance(signed, dict) or not signed.get("complete") or not signed.get("hex"):
        raise RuntimeError("BCHN could not fully sign the reward transaction.")
    signed_hex = signed["hex"]
    try:
        size = len(bytes.fromhex(signed_hex))
    except (ValueError, TypeError) as exc:
        raise RuntimeError("BCHN returned an invalid signed transaction.") from exc
    if fee < size:
        raise RuntimeError("Reward transaction fee is below one satoshi per byte.")
    decoded = bch_rpc("decoderawtransaction", [signed_hex])
    txid = decoded.get("txid") if isinstance(decoded, dict) else None
    if not isinstance(txid, str) or not TXID_RE.fullmatch(txid):
        raise RuntimeError("BCHN returned an invalid reward transaction ID.")
    return signed_hex, txid.lower()


def process_one_reward() -> bool:
    with sqlite3.connect(DB_PATH, timeout=60) as db:
        db.execute("BEGIN IMMEDIATE")
        row = db.execute(
            """SELECT cash_address, category, signed_tx, txid FROM token_rewards
               WHERE sent_at IS NULL ORDER BY signed_tx IS NULL, rowid LIMIT 1"""
        ).fetchone()
        if not row:
            return False
        address, category, signed_tx, txid = row
        if not signed_tx:
            signed_tx, txid = build_reward_transaction(address, category)
            db.execute(
                "UPDATE token_rewards SET signed_tx = ?, txid = ? WHERE cash_address = ?",
                (signed_tx, txid, address),
            )
            # Persist the exact transaction before any broadcast, so retries cannot
            # accidentally create a second payment after an ambiguous RPC failure.
            db.commit()
            return True
        try:
            result = bch_rpc("sendrawtransaction", [signed_tx])
        except RuntimeError as broadcast_error:
            try:
                known = bch_rpc("gettransaction", [txid], wallet=True)
            except RuntimeError:
                raise broadcast_error
            if not isinstance(known, dict) or known.get("confirmations", 0) < 0:
                raise broadcast_error
            if known.get("confirmations", 0) == 0:
                try:
                    bch_rpc("getmempoolentry", [txid])
                except RuntimeError:
                    raise broadcast_error
        else:
            if not isinstance(result, str) or result.lower() != txid:
                raise RuntimeError("BCHN returned a mismatched broadcast transaction ID.")
        db.execute(
            "UPDATE token_rewards SET sent_at = CURRENT_TIMESTAMP WHERE cash_address = ?",
            (address,),
        )
        return True


def reward_worker() -> None:
    while not reward_stop.is_set():
        try:
            if process_one_reward():
                continue
        except (RuntimeError, sqlite3.Error, ValueError, KeyError, TypeError):
            logger.exception("Could not process token reward; it will be retried.")
        reward_stop.wait(30)


def verify_confirmed_payment(txid: str) -> dict:
    """
    Verify that:
      * BCHN knows the transaction and it has enough confirmations;
      * each input spends an output whose decoded address is the configured sender;
      * every configured category appears in an output with a positive fungible amount.

    Requires BCHN getrawtransaction verbosity=2, which returns input scripts
    and CashToken data. Pruning may make old confirmed transactions unavailable.
    """
    if not BCH_ALLOWED_SENDER:
        raise RuntimeError("BCH_ALLOWED_SENDER is not configured.")
    sender_info = bch_rpc("validateaddress", [BCH_ALLOWED_SENDER])
    sender_script = sender_info.get("scriptPubKey") if isinstance(sender_info, dict) else None
    if not isinstance(sender_info, dict) or not sender_info.get("isvalid") or not sender_script:
        raise RuntimeError("BCH_ALLOWED_SENDER is not a valid address.")

    try:
        tx = bch_rpc("getrawtransaction", [txid, 2])
    except RuntimeError as exc:
        raise ValueError(
            "BCHN could not retrieve this transaction. It may be unknown, "
            "or its block may have been pruned."
        ) from exc

    if not isinstance(tx, dict) or tx.get("txid", "").lower() != txid.lower():
        raise ValueError("BCHN returned a mismatched transaction.")

    confirmations = tx.get("confirmations", 0)
    if not isinstance(confirmations, int) or confirmations < BCH_REQUIRED_CONFIRMATIONS:
        raise ValueError(
            f"Transaction needs at least {BCH_REQUIRED_CONFIRMATIONS} confirmation(s)."
        )

    inputs = tx.get("vin", [])
    if not inputs or any("coinbase" in vin for vin in inputs):
        raise ValueError("Transaction must have ordinary, non-coinbase inputs.")

    # Strict policy: every input must spend an output controlled by this address.
    for vin in inputs:
        prevout = vin.get("prevout")
        script = prevout.get("scriptPubKey", {}) if isinstance(prevout, dict) else vin.get("scriptPubKey", {})
        if not isinstance(script, dict):
            raise ValueError("Could not identify an input's previous-output script.")
        if not isinstance(script.get("hex"), str):
            raise ValueError("Could not identify an input's previous-output script.")
        if script["hex"].lower() != sender_script.lower():
            raise ValueError("Every transaction input must come from BCH_ALLOWED_SENDER.")

    # Count token amounts in outputs only. This verifies fungible token output,
    # not NFTs; NFTs do not satisfy the positive-amount requirement.
    output_amounts = {category: 0 for category in BCH_ALLOWED_TOKEN_CATEGORIES}

    for vout in tx.get("vout", []):
        token_data = vout.get("tokenData")
        if not isinstance(token_data, dict):
            continue

        category = str(token_data.get("category", "")).lower()
        if category not in output_amounts:
            continue

        try:
            amount = int(token_data.get("amount", "0"))
        except (TypeError, ValueError):
            raise ValueError("BCHN returned an invalid CashToken amount.")

        if amount > 0:
            output_amounts[category] += amount

    missing = [
        category
        for category, amount in output_amounts.items()
        if amount <= 0
    ]
    if missing:
        raise ValueError(
            "Transaction does not contain positive fungible output amounts "
            "for every configured token category."
        )

    return {
        "txid": tx["txid"],
        "confirmations": confirmations,
        "token_amounts": {
            category: str(amount)
            for category, amount in output_amounts.items()
        },
    }

