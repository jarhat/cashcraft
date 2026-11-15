import os
import re
import sqlite3
from pathlib import Path

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
#BCH_ALLOWED_SENDER = os.getenv("BCH_ALLOWED_SENDER", "").strip().lower()

CATEGORY_RE = re.compile(r"^[0-9a-fA-F]{64}$")
TXID_RE = re.compile(r"^[0-9a-fA-F]{64}$")

try:
    BCH_REQUIRED_CONFIRMATIONS = int(
        os.getenv("BCH_REQUIRED_CONFIRMATIONS", "1")
    )
except ValueError as exc:
    raise RuntimeError("BCH_REQUIRED_CONFIRMATIONS must be an integer.") from exc

if BCH_REQUIRED_CONFIRMATIONS < 1:
    raise RuntimeError("BCH_REQUIRED_CONFIRMATIONS must be at least 1.")

_raw_categories = os.getenv("BCH_ALLOWED_TOKEN_CATEGORIES", "")
BCH_ALLOWED_TOKEN_CATEGORIES = {
    item.strip().lower()
    for item in _raw_categories.split(",")
    if item.strip()
}

if not BCH_RPC_USER or not BCH_RPC_PASSWORD:
    raise RuntimeError("Set BCH_RPC_USER and BCH_RPC_PASSWORD.")

#if not BCH_ALLOWED_SENDER:
#    raise RuntimeError("Set BCH_ALLOWED_SENDER.")

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


@app.on_event("startup")
def startup() -> None:
    init_db()

def _insert_cash_address(
    db: sqlite3.Connection,
    address: str,
    prefix: str,
    address_type: int,
) -> None:
    db.execute(
        """
        INSERT INTO cash_addresses
            (cash_address, network, prefix, address_type)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(cash_address) DO NOTHING
        """,
        (address, NETWORK, prefix, address_type),
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

def bch_rpc(method: str, params: list):
    try:
        response = httpx.post(
            BCH_RPC_URL,
            auth=(BCH_RPC_USER, BCH_RPC_PASSWORD),
            json={
                "jsonrpc": "1.0",
                "id": "cash-address-proof",
                "method": method,
                "params": params,
            },
            timeout=30.0,
        )
        response.raise_for_status()
        payload = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise RuntimeError("Could not communicate with BCHN.") from exc

    if payload.get("error"):
        rpc_error = payload["error"]
        message = (
            rpc_error.get("message", "BCHN RPC error")
            if isinstance(rpc_error, dict)
            else str(rpc_error)
        )
        raise RuntimeError(message)

    return payload.get("result")


def verify_confirmed_payment(txid: str) -> dict:
    """
    Verify that:
      * BCHN knows the transaction and it has enough confirmations;
      * each input spends an output whose decoded address is the configured sender;
      * every configured category appears in an output with a positive fungible amount.

    Requires BCHN getrawtransaction verbosity=2, which returns input prevouts
    and CashToken data. Pruning may make old confirmed transactions unavailable.
    """
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
        script = prevout.get("scriptPubKey", {}) if isinstance(prevout, dict) else {}
        input_address = script.get("address")

        if not input_address and isinstance(script.get("addresses"), list):
            addresses = script["addresses"]
            input_address = addresses[0] if len(addresses) == 1 else None

        if not isinstance(input_address, str):
            raise ValueError("Could not identify an input's previous-output address.")

        try:
            normalized_input, _, _ = validate_token_aware_cashaddr(input_address)
        except ValueError as exc:
            raise ValueError(
                "An input has an address that cannot be validated for this network."
            ) from exc

        if normalized_input != BCH_ALLOWED_SENDER:
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

