import os
import html
import io
import math
import re
import secrets
import sqlite3
import time
import logging
import threading
from contextlib import contextmanager
from decimal import Decimal
from pathlib import Path
from typing import Iterator, Literal
from urllib.parse import quote

import httpx
import segno
from PIL import Image, ImageDraw, ImageFont, ImageOps
from fastapi import FastAPI, HTTPException, Request, Response
from urllib.parse import parse_qs, urlsplit
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

if any(not CATEGORY_RE.fullmatch(c) for c in BCH_ALLOWED_TOKEN_CATEGORIES):
    raise RuntimeError(
        "Each BCH_ALLOWED_TOKEN_CATEGORIES entry must be 64 hex characters."
    )


DB_PATH = Path(os.getenv("CASHADDR_DB_PATH", "/data/cash-addresses.sqlite3"))
NETCRAFT_DB_PATH = os.getenv("NETCRAFT_DB_PATH", "").strip()
NETCRAFT_MINING_REWARDS_ENABLED = os.getenv("NETCRAFT_MINING_REWARDS_ENABLED", "false")
NETCRAFT_REWARD_WAKE_SECRET = os.getenv("NETCRAFT_REWARD_WAKE_SECRET", "")
try:
    NETCRAFT_DAILY_PAYOUT_LIMIT = int(os.getenv("NETCRAFT_DAILY_PAYOUT_LIMIT", "1000"))
    NETCRAFT_ADDRESS_DAILY_PAYOUT_LIMIT = int(os.getenv("NETCRAFT_ADDRESS_DAILY_PAYOUT_LIMIT", "100"))
except ValueError as exc:
    raise RuntimeError("Mining payout limits must be positive integers.") from exc
if NETCRAFT_DAILY_PAYOUT_LIMIT <= 0 or NETCRAFT_ADDRESS_DAILY_PAYOUT_LIMIT <= 0:
    raise RuntimeError("Mining payout limits must be positive integers.")
if NETCRAFT_MINING_REWARDS_ENABLED not in ("true", "false"):
    raise RuntimeError("NETCRAFT_MINING_REWARDS_ENABLED must be true or false.")

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
reward_wake = threading.Event()
reward_thread = None
db_identity = None


class RewardDatabaseError(RuntimeError):
    pass

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


SHORT_LINK_TTL_SECONDS = {"1d": 86400, "1w": 7 * 86400, "1m": 30 * 86400}
SHORT_LINK_ID_RE = re.compile(r"[A-Za-z0-9_-]{8,32}")
SHORT_LINK_MAX_ROWS = 50000
SHORT_LINK_HOURLY_LIMIT = 300


class ShortLinkRequest(BaseModel):
    address: str = Field(min_length=1, max_length=120)
    category: str = Field(min_length=64, max_length=64)
    amount: str = Field(min_length=1, max_length=30)
    note: str = Field(default="", max_length=280)
    one_time: bool = False
    expires_in: Literal["1d", "1w", "1m"] = "1w"


class CashAddressRequest(BaseModel):
    cash_address: str = Field(min_length=1, max_length=120)


def init_db() -> None:
    global db_identity
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
        if db.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'beer_rewards'").fetchone():
            db.execute("ALTER TABLE beer_rewards RENAME TO legacy_bonus_rewards")
        db.execute("""
            CREATE TABLE IF NOT EXISTS legacy_bonus_rewards (
                cash_address TEXT PRIMARY KEY,
                category TEXT NOT NULL,
                signed_tx TEXT,
                txid TEXT,
                sent_at TEXT,
                FOREIGN KEY (cash_address) REFERENCES token_rewards(cash_address)
            )
        """)
        columns = {row[1] for row in db.execute("PRAGMA table_info(legacy_bonus_rewards)")}
        if "cancelled_at" not in columns:
            db.execute("ALTER TABLE legacy_bonus_rewards ADD COLUMN cancelled_at TEXT")
        db.execute(
            "UPDATE legacy_bonus_rewards SET cancelled_at = CURRENT_TIMESTAMP "
            "WHERE sent_at IS NULL AND cancelled_at IS NULL"
        )
        db.execute("""
            CREATE TABLE IF NOT EXISTS short_links (
                id TEXT PRIMARY KEY,
                address TEXT NOT NULL,
                category TEXT NOT NULL,
                amount TEXT NOT NULL,
                note TEXT NOT NULL,
                one_time INTEGER NOT NULL,
                created_at INTEGER NOT NULL,
                expires_at INTEGER NOT NULL
            )
        """)
        db.execute("""
            CREATE TABLE IF NOT EXISTS donation_addresses (
                network TEXT PRIMARY KEY,
                address TEXT NOT NULL
            )
        """)
        db.execute("CREATE INDEX IF NOT EXISTS short_links_expires ON short_links (expires_at)")
    stat = DB_PATH.stat()
    db_identity = (stat.st_dev, stat.st_ino)


@contextmanager
def open_db(timeout: int) -> Iterator[sqlite3.Connection]:
    try:
        stat = DB_PATH.stat()
    except FileNotFoundError as exc:
        raise RewardDatabaseError(
            f"Database {DB_PATH} is missing; restore the original database and restart auth."
        ) from exc
    if db_identity is None or (stat.st_dev, stat.st_ino) != db_identity:
        raise RewardDatabaseError(
            f"Database {DB_PATH} changed since startup; restore the original database and restart auth."
        )
    db = sqlite3.connect(DB_PATH.resolve().as_uri() + "?mode=rw", uri=True, timeout=timeout)
    try:
        try:
            stat = DB_PATH.stat()
        except FileNotFoundError as exc:
            raise RewardDatabaseError(
                f"Database {DB_PATH} is missing; restore the original database and restart auth."
            ) from exc
        if (stat.st_dev, stat.st_ino) != db_identity:
            raise RewardDatabaseError(
                f"Database {DB_PATH} changed since startup; restore the original database and restart auth."
            )
        table = db.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'token_rewards'"
        ).fetchone()
        if table is None:
            raise RewardDatabaseError(
                f"Database {DB_PATH} lost its token_rewards table after startup; "
                "restore the original database and restart auth."
            )
        with db:
            yield db
    finally:
        db.close()


@app.on_event("startup")
def startup() -> None:
    global reward_thread
    init_db()
    reward_stop.clear()
    reward_wake.clear()
    reward_thread = threading.Thread(target=reward_worker, daemon=True)
    reward_thread.start()
    threading.Thread(target=prepare_donation_address, daemon=True).start()


@app.on_event("shutdown")
def shutdown() -> None:
    reward_stop.set()
    reward_wake.set()
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
    with open_db(timeout=10) as db:
        _insert_cash_address(db, address, prefix, address_type)


def save_cash_address_with_proof(
    address: str,
    prefix: str,
    address_type: int,
    txid: str,
) -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)

    with open_db(timeout=10) as db:
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


def validate_cashaddr(value: str, *, token_aware: bool = True) -> tuple[str, str, int]:
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
    if address_type not in ({2, 3} if token_aware else {0, 1, 2, 3}):
        raise ValueError(
            "Address is valid CashAddr but is not CashToken-aware. "
            "Use a token-aware P2PKH or P2SH address."
        )

    return address, prefix, address_type


def validate_token_aware_cashaddr(value: str) -> tuple[str, str, int]:
    return validate_cashaddr(value, token_aware=True)


@app.get("/health")
def health() -> dict[str, str]:
    return {
        "status": "ok",
        "network": NETWORK,
    }


@app.get("/api/token-reward")
def token_reward() -> dict[str, str]:
    return {"category": BCH_REWARD_CATEGORY}


@app.get("/api/donation-address")
def donation_address() -> dict[str, str]:
    try:
        with open_db(timeout=60) as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT address FROM donation_addresses WHERE network = ?", (NETWORK,)).fetchone()
            if row:
                address = row[0]
            else:
                address = bch_rpc("getnewaddress", ["cashcraft donations"], wallet=True)
                address, _, _ = validate_cashaddr(address, token_aware=False)
                db.execute("INSERT INTO donation_addresses (network, address) VALUES (?, ?)", (NETWORK, address))
            return {"address": address, "network": NETWORK}
    except (RewardDatabaseError, RuntimeError, ValueError, sqlite3.Error) as exc:
        logger.error("Donation address unavailable (%s)", type(exc).__name__)
        raise HTTPException(status_code=503, detail="Donation address unavailable.") from exc


def prepare_donation_address() -> None:
    while not reward_stop.is_set():
        try:
            donation_address()
            return
        except HTTPException as exc:
            logger.warning("Could not prepare donation address (%s); the preview will omit the QR code.", exc.status_code)
            reward_stop.wait(60)


@app.get("/api/craft-preview.png")
def craft_preview_image() -> Response:
    address = None
    try:
        with open_db(timeout=1) as db:
            row = db.execute("SELECT address FROM donation_addresses WHERE network = ?", (NETWORK,)).fetchone()
            if row:
                address = row[0]
    except (RewardDatabaseError, sqlite3.Error) as exc:
        logger.warning("Could not read the donation address for the preview (%s)", type(exc).__name__)
    path = Path(os.getenv(
        "CRAFT_PREVIEW_IMAGE", str(Path(__file__).resolve().parent.parent / "public" / "craft-preview.png")
    ))
    try:
        with Image.open(path) as source:
            image = ImageOps.fit(source.convert("RGB"), (1200, 675), method=Image.Resampling.LANCZOS)
        if address:
            draw = ImageDraw.Draw(image)
            width, height = image.size
            qr = segno.make(address, error="h")
            modules = list(qr.matrix)
            scale = max(1, min(width, height) // (3 * (len(modules) + 8)))
            qr_size = (len(modules) + 8) * scale
            left, top = width - qr_size - 28, height - qr_size - 74
            if left < 8 or top < 45:
                raise ValueError("Preview image is too small")
            draw.rounded_rectangle((left - 12, top - 42, width - 16, height - 18), radius=14, fill="white")
            font = ImageFont.load_default(size=max(12, scale * 3))
            draw.text((left + 27, top - 32), "DONATE BCH", fill="#183c28", font=font)
            draw.ellipse((left, top - 31, left + 10, top - 21), fill="#d62647")
            draw.ellipse((left + 8, top - 31, left + 18, top - 21), fill="#d62647")
            draw.polygon(((left, top - 25), (left + 18, top - 25), (left + 9, top - 15)), fill="#d62647")
            for y, row in enumerate(modules):
                for x, dark in enumerate(row):
                    if dark:
                        x0, y0 = left + (x + 4) * scale, top + (y + 4) * scale
                        draw.rectangle((x0, y0, x0 + scale - 1, y0 + scale - 1), fill="black")
        output = io.BytesIO()
        image.save(output, format="PNG", optimize=True)
    except (OSError, ValueError) as exc:
        logger.error("Could not generate craft preview (%s)", type(exc).__name__)
        raise HTTPException(status_code=503, detail="Craft preview unavailable.") from exc
    return Response(content=output.getvalue(), media_type="image/png",
                    headers={"Cache-Control": f"public, max-age={300 if address else 30}"})


_chain_status_lock = threading.Lock()
_chain_status_cache: dict | None = None
_chain_status_cached_at = 0.0


@app.get("/api/chain-status")
def chain_status() -> dict:
    global _chain_status_cache, _chain_status_cached_at
    with _chain_status_lock:
        if _chain_status_cache is not None and time.monotonic() - _chain_status_cached_at < 20:
            return _chain_status_cache
        try:
            info = bch_rpc("getblockchaininfo", [])
            if not isinstance(info, dict):
                raise ValueError("Invalid blockchain info")
            blocks, headers = info["blocks"], info["headers"]
            difficulty, block_hash = info["difficulty"], info["bestblockhash"]
            if (
                info["chain"] != "main"
                or type(blocks) is not int or blocks < 0
                or type(headers) is not int or headers < blocks
                or type(difficulty) not in (int, float)
                or not math.isfinite(difficulty) or difficulty <= 0
                or not isinstance(block_hash, str) or not re.fullmatch(r"[0-9a-fA-F]{64}", block_hash)
                or type(info["initialblockdownload"]) is not bool
            ):
                raise ValueError("Invalid blockchain info")
            _chain_status_cache = {
                "network": "mainnet",
                "blocks": blocks,
                "headers": headers,
                "best_block_hash": block_hash.lower(),
                "difficulty": difficulty,
                "syncing": info["initialblockdownload"] or headers > blocks,
            }
            _chain_status_cached_at = time.monotonic()
            return _chain_status_cache
        except (RuntimeError, ValueError, KeyError) as exc:
            logger.warning("BCHN chain status unavailable: %s", type(exc).__name__)
            raise HTTPException(status_code=503, detail="Blockchain status unavailable.") from exc


def purge_expired_short_links() -> None:
    with open_db(timeout=10) as db:
        db.execute("DELETE FROM short_links WHERE expires_at <= ?", (int(time.time()),))


@app.post("/api/short-link", status_code=201)
def create_short_link(request: ShortLinkRequest) -> dict[str, str | bool | int]:
    try:
        address, _, _ = validate_token_aware_cashaddr(request.address)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    category = request.category.strip().lower()
    if not re.fullmatch(r"[0-9a-f]{64}", category):
        raise HTTPException(status_code=422, detail="Invalid category ID.")
    if not re.fullmatch(r"[1-9][0-9]{0,29}", request.amount):
        raise HTTPException(status_code=422, detail="Invalid amount.")

    now = int(time.time())
    expires_at = now + SHORT_LINK_TTL_SECONDS[request.expires_in]
    link_id = secrets.token_urlsafe(9)
    try:
        with open_db(timeout=10) as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("DELETE FROM short_links WHERE expires_at <= ?", (now,))
            total, recent = db.execute(
                "SELECT COUNT(*), COALESCE(SUM(created_at > ?), 0) FROM short_links",
                (now - 3600,),
            ).fetchone()
            if total >= SHORT_LINK_MAX_ROWS or recent >= SHORT_LINK_HOURLY_LIMIT:
                raise HTTPException(status_code=429, detail="Too many short links. Try again later.")
            db.execute(
                "INSERT INTO short_links (id, address, category, amount, note, one_time, created_at, expires_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (link_id, address, category, request.amount, request.note.strip(),
                 int(request.one_time), now, expires_at),
            )
    except RewardDatabaseError as exc:
        logger.exception("Short link database unavailable.")
        raise HTTPException(status_code=503, detail="Link database unavailable.") from exc
    except sqlite3.Error as exc:
        raise HTTPException(status_code=500, detail="Could not create short link.") from exc
    return {"id": link_id, "one_time": request.one_time, "expires_at": expires_at}


@app.post("/api/short-link/{link_id}/open")
def open_short_link(link_id: str) -> dict[str, str | bool]:
    # POST so link previews and crawlers that only issue GET cannot consume a one-time link.
    if not SHORT_LINK_ID_RE.fullmatch(link_id):
        raise HTTPException(status_code=404, detail="This link is unavailable.")
    now = int(time.time())
    try:
        with open_db(timeout=10) as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("DELETE FROM short_links WHERE expires_at <= ?", (now,))
            row = db.execute(
                "SELECT address, category, amount, note, one_time FROM short_links WHERE id = ?",
                (link_id,),
            ).fetchone()
            if row is None:
                raise HTTPException(status_code=404, detail="This link is unavailable.")
            if row[4]:
                db.execute("DELETE FROM short_links WHERE id = ?", (link_id,))
    except RewardDatabaseError as exc:
        logger.exception("Short link database unavailable.")
        raise HTTPException(status_code=503, detail="Link database unavailable.") from exc
    except sqlite3.Error as exc:
        raise HTTPException(status_code=500, detail="Could not open short link.") from exc
    return {"address": row[0], "category": row[1], "amount": row[2], "note": row[3], "one_time": bool(row[4])}


def peek_short_link(link_id: str):
    """Read a link without consuming it so previews never burn one-time links."""
    if not SHORT_LINK_ID_RE.fullmatch(link_id):
        return None
    try:
        with open_db(timeout=10) as db:
            return db.execute(
                "SELECT address, category, amount FROM short_links WHERE id = ? AND expires_at > ?",
                (link_id, int(time.time())),
            ).fetchone()
    except (RewardDatabaseError, sqlite3.Error):
        return None


def request_origin(request: Request) -> str:
    origin = request.headers.get("x-preview-origin", "")
    parts = urlsplit(origin)
    if parts.scheme in {"http", "https"} and parts.netloc and not parts.path.strip("/"):
        return f"{parts.scheme}://{parts.netloc}"
    return ""


def valid_payment(address: str, category: str, amount: str):
    try:
        address, _, _ = validate_token_aware_cashaddr(address)
    except ValueError:
        return None
    category = category.strip().lower()
    if re.fullmatch(r"[0-9a-f]{64}", category) and re.fullmatch(r"[1-9][0-9]{0,29}", amount):
        return address, category, amount
    return None


@app.get("/api/qr.png")
def payment_qr(request: Request, addr: str = "", category: str = "", amount: str = "", s: str = ""):
    origin = request_origin(request)
    if not origin:
        raise HTTPException(status_code=400, detail="Payment link origin unavailable.")
    if s:
        if not peek_short_link(s):
            raise HTTPException(status_code=404, detail="This link is unavailable.")
        target = f"{origin}/s/{s}"
    else:
        payment = valid_payment(addr, category, amount)
        if not payment:
            raise HTTPException(status_code=422, detail="Invalid payment request.")
        query = "&".join(f"{k}={quote(v, safe='')}" for k, v in zip(("addr", "amount", "category"), (payment[0], payment[2], payment[1])))
        target = f"{origin}/?{query}"
    buffer = io.BytesIO()
    segno.make(target, error="m").save(buffer, kind="png", scale=12, border=4, dark="#07111b", light="#ffffff")
    return Response(buffer.getvalue(), media_type="image/png", headers={"Cache-Control": "public, max-age=300"})


@app.get("/api/preview")
def link_preview(request: Request) -> Response:
    """Static HTML with Open Graph tags for chat-app link unfurlers; never includes the note."""
    origin = request_origin(request)
    original = request.headers.get("x-original-uri", "/")
    parts = urlsplit(original)
    query = parse_qs(parts.query)
    payment = None
    image_query = ""
    short_match = re.fullmatch(r"/s/([A-Za-z0-9_-]{8,32})/?", parts.path)
    if short_match:
        row = peek_short_link(short_match.group(1))
        if row:
            payment = valid_payment(*row)
            image_query = "s=" + short_match.group(1)
    elif parts.path == "/":
        payment = valid_payment(*(query.get(k, [""])[0] for k in ("addr", "category", "amount")))
        if payment:
            image_query = "&".join(f"{k}={quote(v, safe='')}" for k, v in zip(("addr", "category", "amount"), payment))
    if payment and origin:
        title = f"Payment request: {payment[2]} token base units"
        description = f"Send {payment[2]} token base units to {payment[0]} (category {payment[1][:12]}…)."
        image = f"{origin}/api/qr.png?{image_query}"
    else:
        title = "CTF Cash | Bitcoin Cash CashTokens"
        description = "Send and receive CashTokens, create payment links and QR codes, and track token balances with your Bitcoin Cash wallet."
        image = f"{origin}/social-preview.png" if origin else ""
    url = f"{origin}{original}"
    e = html.escape
    page = (
        '<!doctype html><html lang="en"><head><meta charset="utf-8">'
        f"<title>{e(title)}</title>"
        f'<meta name="description" content="{e(description)}">'
        '<meta property="og:type" content="website"><meta property="og:site_name" content="CTF Cash">'
        f'<meta property="og:title" content="{e(title)}"><meta property="og:description" content="{e(description)}">'
        f'<meta property="og:url" content="{e(url)}">'
        + (f'<meta property="og:image" content="{e(image)}"><meta property="og:image:width" content="592">'
           f'<meta name="twitter:image" content="{e(image)}">' if image else "")
        + '<meta name="twitter:card" content="summary_large_image">'
        f'<meta http-equiv="refresh" content="0;url={e(url)}"></head><body><a href="{e(url)}">{e(title)}</a></body></html>'
    )
    return Response(page, media_type="text/html")


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
    except RewardDatabaseError as exc:
        logger.exception("Could not save cash address.")
        raise HTTPException(status_code=503, detail="Address database unavailable.") from exc
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


@app.post("/api/beer-reward")
def discontinued_bonus_reward(request: CashAddressRequest) -> dict:
    raise HTTPException(status_code=409, detail="The bonus reward has been discontinued.")

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
    except RewardDatabaseError as exc:
        logger.exception("Could not save cash address and proof.")
        raise HTTPException(status_code=503, detail="Address database unavailable.") from exc
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


def check_balance() -> int:
    """Return the payout wallet's BCH balance in satoshis for backend use."""
    return _satoshis(bch_rpc("getbalance", [], wallet=True))


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
    with open_db(timeout=60) as db:
        db.execute("BEGIN IMMEDIATE")
        table = "token_rewards"
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
                f"UPDATE {table} SET signed_tx = ?, txid = ? WHERE cash_address = ?",
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
            f"UPDATE {table} SET sent_at = CURRENT_TIMESTAMP WHERE cash_address = ?",
            (address,),
        )
        return True


def process_one_mining_reward() -> bool:
    if NETCRAFT_MINING_REWARDS_ENABLED != "true" or not NETCRAFT_DB_PATH:
        return False
    with sqlite3.connect(
        Path(NETCRAFT_DB_PATH).resolve().as_uri() + "?mode=rw",
        uri=True,
        timeout=10,
    ) as db:
        db.execute("""CREATE TABLE IF NOT EXISTS mining_payout_reservations (
            reward_id INTEGER NOT NULL, day TEXT NOT NULL, PRIMARY KEY (reward_id, day)
        )""")
        db.execute("CREATE INDEX IF NOT EXISTS mining_payout_reservations_day ON mining_payout_reservations (day)")
        row = db.execute(
            """WITH daily_address_counts AS (
                   SELECT m.cash_address, COUNT(*) AS count
                   FROM mining_payout_reservations r
                   JOIN mining_rewards m ON m.id = r.reward_id
                   WHERE r.day = date('now') GROUP BY m.cash_address
               )
               SELECT id, cash_address, category, signed_tx, txid FROM mining_rewards m
               WHERE sent_at IS NULL AND (
                   EXISTS (SELECT 1 FROM mining_payout_reservations r
                           WHERE r.reward_id = m.id AND r.day = date('now'))
                   OR (
                       (SELECT COUNT(*) FROM mining_payout_reservations WHERE day = date('now')) < ?
                       AND COALESCE((SELECT count FROM daily_address_counts c
                                     WHERE c.cash_address = m.cash_address), 0) < ?
                   )
               ) ORDER BY signed_tx IS NULL, id LIMIT 1""",
            (NETCRAFT_DAILY_PAYOUT_LIMIT, NETCRAFT_ADDRESS_DAILY_PAYOUT_LIMIT),
        ).fetchone()
        if not row:
            return False
        reward_id, address, category, signed_tx, txid = row
        validate_token_aware_cashaddr(address)
        if not CATEGORY_RE.fullmatch(category):
            raise RuntimeError("Invalid mining reward category.")
        if not signed_tx:
            candidate, candidate_txid = build_reward_transaction(address, category)
            db.execute(
                """UPDATE mining_rewards SET signed_tx = ?, txid = ?
                   WHERE id = ? AND signed_tx IS NULL AND sent_at IS NULL""",
                (candidate, candidate_txid, reward_id),
            )
            db.commit()
            return True
        db.execute("BEGIN IMMEDIATE")
        day = db.execute("SELECT date('now')").fetchone()[0]
        reserved = db.execute(
            "SELECT 1 FROM mining_payout_reservations WHERE reward_id = ? AND day = ?",
            (reward_id, day),
        ).fetchone()
        if not reserved:
            count = db.execute(
                "SELECT COUNT(*) FROM mining_payout_reservations WHERE day = ?", (day,)
            ).fetchone()[0]
            address_count = db.execute(
                """SELECT COUNT(*) FROM mining_payout_reservations r
                   JOIN mining_rewards m ON m.id = r.reward_id
                   WHERE r.day = ? AND m.cash_address = ?""",
                (day, address),
            ).fetchone()[0]
            if count >= NETCRAFT_DAILY_PAYOUT_LIMIT or address_count >= NETCRAFT_ADDRESS_DAILY_PAYOUT_LIMIT:
                db.rollback()
                return False
            db.execute(
                "INSERT INTO mining_payout_reservations (reward_id, day) VALUES (?, ?)",
                (reward_id, day),
            )
        db.commit()
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
            "UPDATE mining_rewards SET sent_at = CURRENT_TIMESTAMP WHERE id = ?",
            (reward_id,),
        )
        return True


def reward_worker() -> None:
    while not reward_stop.is_set():
        reward_wake.clear()
        try:
            purge_expired_short_links()
        except (RewardDatabaseError, sqlite3.Error) as exc:
            logger.error("Could not purge short links: %s", type(exc).__name__)
        processed = False
        for name, process in (("wallet rewards", process_one_reward), ("mining rewards", process_one_mining_reward)):
            try:
                processed = process() or processed
            except (RewardDatabaseError, RuntimeError, sqlite3.Error, ValueError, KeyError, TypeError) as exc:
                logger.error("Could not process %s (%s); it will be retried.", name, type(exc).__name__)
        if not processed:
            reward_wake.wait(30)


@app.post("/api/internal/netcraft-reward-wake", status_code=204)
def wake_mining_rewards(request: Request) -> Response:
    provided = request.headers.get("authorization", "")
    if not NETCRAFT_REWARD_WAKE_SECRET or not secrets.compare_digest(
        provided.encode("utf-8"), f"Bearer {NETCRAFT_REWARD_WAKE_SECRET}".encode("utf-8")
    ):
        raise HTTPException(status_code=403, detail="Forbidden")
    reward_wake.set()
    return Response(status_code=204)


@app.get("/api/mina-rewards-sent")
def mina_rewards_sent() -> dict:
    try:
        with open_db(timeout=5) as db:
            total = sum(
                db.execute(
                    f"SELECT COUNT(*) FROM {table} WHERE category = ? AND sent_at IS NOT NULL",
                    (BCH_REWARD_CATEGORY,),
                ).fetchone()[0]
                for table in ("token_rewards", "legacy_bonus_rewards")
            )
        if NETCRAFT_DB_PATH:
            with sqlite3.connect(
                Path(NETCRAFT_DB_PATH).resolve().as_uri() + "?mode=ro", uri=True, timeout=5
            ) as db:
                total += db.execute(
                    "SELECT COUNT(*) FROM mining_rewards WHERE category = ? AND sent_at IS NOT NULL",
                    (BCH_REWARD_CATEGORY,),
                ).fetchone()[0]
    except (RewardDatabaseError, sqlite3.Error) as exc:
        logger.error("Could not read MINA payout total: %s", type(exc).__name__)
        raise HTTPException(status_code=503, detail="Payout total unavailable") from exc
    return {"sent": str(total)}


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
    if not BCH_ALLOWED_TOKEN_CATEGORIES:
        raise RuntimeError("BCH_ALLOWED_TOKEN_CATEGORIES is not configured.")

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

