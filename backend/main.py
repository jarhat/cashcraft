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
from PIL import Image, ImageOps
from fastapi import FastAPI, HTTPException, Request, Response
from urllib.parse import parse_qs, urlsplit
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from reward_broadcast import broadcast_reward

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
BCH_WALLET = os.getenv("BCH_WALLET", "token-sender").strip()
BCH_REWARD_CATEGORY = os.getenv("BCH_REWARD_CATEGORY", "").strip().lower()

CATEGORY_RE = re.compile(r"^[0-9a-fA-F]{64}$")
TXID_RE = re.compile(r"^[0-9a-fA-F]{64}$")

if not BCH_RPC_USER or not BCH_RPC_PASSWORD:
    raise RuntimeError("Set BCH_RPC_USER and BCH_RPC_PASSWORD.")

if not BCH_WALLET:
    raise RuntimeError("Set BCH_WALLET.")

if not CATEGORY_RE.fullmatch(BCH_REWARD_CATEGORY):
    raise RuntimeError("Set BCH_REWARD_CATEGORY to a 64-character category ID.")

CRAFTING_ADDRESS = os.getenv("CRAFTING_ADDRESS", "").strip()
CRAFTING_RETURN_CATEGORY = os.getenv("CRAFTING_RETURN_CATEGORY", "").strip().lower()
if CRAFTING_ADDRESS and not CRAFTING_ADDRESS.startswith("bitcoincash:z"):
    raise RuntimeError("Set CRAFTING_ADDRESS to a token-aware CashAddr (bitcoincash:z…).")
if CRAFTING_RETURN_CATEGORY and not CATEGORY_RE.fullmatch(CRAFTING_RETURN_CATEGORY):
    raise RuntimeError("Set CRAFTING_RETURN_CATEGORY to a 64-character category ID or leave it empty.")


DB_PATH = Path(os.getenv("CASHADDR_DB_PATH", "/data/cash-addresses.sqlite3"))
NETCRAFT_MINING_REWARDS_ENABLED = os.getenv("NETCRAFT_MINING_REWARDS_ENABLED", "false")
NETCRAFT_REWARD_WAKE_SECRET = os.getenv("NETCRAFT_REWARD_WAKE_SECRET", "")
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
reward_payout_lock = threading.Lock()
reward_thread = None
db_identity = None
db_state_lock = threading.RLock()


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

class PickaxeClaimRequest(CashAddressRequest):
    txid: str = Field(min_length=64, max_length=64)


def init_db() -> None:
    global db_identity
    with db_state_lock:
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
            db.execute("""
                CREATE TABLE IF NOT EXISTS mining_rewards (
                    id INTEGER PRIMARY KEY,
                    x INTEGER NOT NULL,
                    y INTEGER NOT NULL,
                    z INTEGER NOT NULL,
                    cash_address TEXT NOT NULL,
                    category TEXT NOT NULL,
                    signed_tx TEXT,
                    txid TEXT,
                    sent_at TEXT,
                    player_name TEXT,
                    UNIQUE(x, y, z)
                )
            """)
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
            db.execute("""
                CREATE TABLE IF NOT EXISTS pickaxe_orders (
                    cash_address TEXT PRIMARY KEY,
                    deposit_address TEXT NOT NULL UNIQUE,
                    locking_script TEXT NOT NULL UNIQUE,
                    txid TEXT UNIQUE,
                    unlocked INTEGER NOT NULL DEFAULT 0
                )
            """)
            db.execute("CREATE INDEX IF NOT EXISTS short_links_expires ON short_links (expires_at)")
        stat = DB_PATH.stat()
        db_identity = (stat.st_dev, stat.st_ino)


@contextmanager
def open_db(timeout: int) -> Iterator[sqlite3.Connection]:
    if db_identity is None or not DB_PATH.exists():
        init_db()
    try:
        stat = DB_PATH.stat()
    except FileNotFoundError as exc:
        raise RewardDatabaseError(f"Database {DB_PATH} is unavailable.") from exc
    if db_identity is None or (stat.st_dev, stat.st_ino) != db_identity:
        raise RewardDatabaseError(
            f"Database {DB_PATH} changed since startup; restore the original database and restart auth."
        )
    db = sqlite3.connect(DB_PATH.resolve().as_uri() + "?mode=rw", uri=True, timeout=timeout)
    try:
        try:
            stat = DB_PATH.stat()
        except FileNotFoundError as exc:
            raise RewardDatabaseError(f"Database {DB_PATH} is unavailable.") from exc
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


def save_cash_address(address: str, prefix: str, address_type: int) -> str:
    with open_db(timeout=10) as db:
        _insert_cash_address(db, address, prefix, address_type)
        row = db.execute(
            "SELECT sent_at FROM token_rewards WHERE cash_address = ?", (address,)
        ).fetchone()
        return "sent" if row and row[0] else "pending" if row else "none"


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


@app.get("/api/ore-categories")
def ore_categories() -> dict[str, str]:
    categories = {"green": BCH_REWARD_CATEGORY}
    for color, key in (("red", "BCH_REDSTONE_REWARD_CATEGORY"), ("blue", "BCH_LAPIS_REWARD_CATEGORY")):
        category = os.getenv(key, "").lower()
        if category:
            if not CATEGORY_RE.fullmatch(category) or category in categories.values():
                raise HTTPException(status_code=503, detail="Ore categories are misconfigured.")
            categories[color] = category
    return categories


@app.get("/api/crafting")
def crafting() -> dict[str, str | None]:
    if not CRAFTING_ADDRESS:
        return {"address": None, "returnCategory": None}
    return {"address": CRAFTING_ADDRESS, "returnCategory": CRAFTING_RETURN_CATEGORY or None}


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


@app.get("/api/craft-preview.png")
def craft_preview_image() -> Response:
    path = Path(os.getenv(
        "CRAFT_PREVIEW_IMAGE", str(Path(__file__).resolve().parent.parent / "public" / "craft-preview.png")
    ))
    try:
        with Image.open(path) as source:
            image = ImageOps.fit(source.convert("RGB"), (1200, 675), method=Image.Resampling.LANCZOS)
        output = io.BytesIO()
        image.save(output, format="PNG", optimize=True)
    except (OSError, ValueError) as exc:
        logger.error("Could not generate craft preview (%s)", type(exc).__name__)
        raise HTTPException(status_code=503, detail="Craft preview unavailable.") from exc
    return Response(content=output.getvalue(), media_type="image/png",
                    headers={"Cache-Control": "public, max-age=300"})


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
            for key, field in (("mediantime", "median_time"), ("size_on_disk", "size_on_disk")):
                value = info.get(key)
                if type(value) is int and 0 <= value <= 2**53 - 1:
                    _chain_status_cache[field] = value
            work = info.get("chainwork")
            if isinstance(work, str) and re.fullmatch(r"[0-9a-fA-F]{1,64}", work):
                _chain_status_cache["chainwork"] = work.lower()
            progress = info.get("verificationprogress")
            if type(progress) in (int, float) and 0 <= progress <= 1:
                _chain_status_cache["verification_progress"] = progress
            if type(info.get("pruned")) is bool:
                _chain_status_cache["pruned"] = info["pruned"]
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
        reward_status = save_cash_address(address, prefix, address_type)
    except RewardDatabaseError as exc:
        logger.exception("Could not save cash address.")
        raise HTTPException(status_code=503, detail="Address database unavailable.") from exc
    except sqlite3.Error as exc:
        raise HTTPException(
            status_code=500,
            detail="Could not save cash address.",
        ) from exc

    reward_wake.set()
    return {
        "network": NETWORK,
        "cash_address": address,
        "prefix": prefix,
        "token_aware": True,
        "address_type": address_type,
        "reward_status": reward_status,
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
                "id": "cashcraft",
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
        code = rpc_error.get("code") if isinstance(rpc_error, dict) else None
        logger.error("BCHN RPC %s failed (code %s)", method, code if type(code) is int else "unknown")
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


def pickaxe_deposit_address() -> tuple[str, str]:
    address, prefix, address_type = validate_cashaddr(
        bch_rpc("getnewaddress", ["cashcraft pickaxe"], wallet=True), token_aware=False
    )
    if address_type not in (0, 2):
        raise RuntimeError("BCHN did not return a P2PKH address.")
    payload = bytearray(_convert_5bit_to_8bit([_CHARSET_MAP[c] for c in address.split(":")[1][:-8]]))
    if len(payload) != 21:
        raise RuntimeError("BCHN returned an unsupported P2PKH address.")
    payload[0] = (2 << 3) | (payload[0] & 7)
    bits, accumulator, values = 0, 0, []
    for byte in payload:
        accumulator = (accumulator << 8) | byte
        bits += 8
        while bits >= 5:
            bits -= 5
            values.append((accumulator >> bits) & 31)
    if bits:
        values.append((accumulator << (5 - bits)) & 31)
    checksum = _polymod(_prefix_expand(prefix) + values + [0] * 8)
    values.extend((checksum >> (5 * (7 - i))) & 31 for i in range(8))
    token_address = prefix + ":" + "".join(_CHARSET[v] for v in values)
    validate_token_aware_cashaddr(token_address)
    return token_address, "76a914" + bytes(payload[1:]).hex() + "88ac"


def verify_pickaxe_payment(txid: str, locking_script: str) -> bool:
    transaction = bch_rpc("gettransaction", [txid], wallet=True)
    if not isinstance(transaction, dict) or not isinstance(transaction.get("hex"), str):
        raise RuntimeError("BCHN returned an invalid wallet transaction.")
    decoded = bch_rpc("decoderawtransaction", [transaction["hex"]])
    if (not isinstance(decoded, dict) or not isinstance(decoded.get("txid"), str)
            or decoded["txid"].lower() != txid or not isinstance(decoded.get("vout"), list)
            or type(transaction.get("confirmations")) is not int):
        raise RuntimeError("BCHN returned an invalid decoded transaction.")
    for output in decoded["vout"]:
        if not isinstance(output, dict):
            raise RuntimeError("BCHN returned an invalid transaction output.")
        token = output.get("tokenData", {})
        script = output.get("scriptPubKey", {})
        if (isinstance(script, dict) and isinstance(script.get("hex"), str)
                and isinstance(token, dict) and isinstance(token.get("category"), str)
                and script["hex"].lower() == locking_script
                and token["category"].lower() == BCH_REWARD_CATEGORY
                and token.get("amount") == "2" and "nft" not in token):
            return transaction["confirmations"] >= 1
    raise ValueError("Transaction does not pay 2 MINA to this crafting address.")


@app.post("/api/pickaxe/order")
def pickaxe_order(request: CashAddressRequest) -> dict:
    try:
        address, _, _ = validate_token_aware_cashaddr(request.cash_address)
        with open_db(timeout=30) as db:
            db.execute("BEGIN IMMEDIATE")
            earned = db.execute(
                "SELECT COUNT(*) FROM mining_rewards WHERE cash_address=? AND category=?",
                (address, BCH_REWARD_CATEGORY),
            ).fetchone()[0]
            if earned < 2:
                raise HTTPException(status_code=403, detail="Mine 20 natural MINA ore blocks first.")
            row = db.execute(
                "SELECT deposit_address, unlocked, txid FROM pickaxe_orders WHERE cash_address=?", (address,)
            ).fetchone()
            if row is None:
                deposit, script = pickaxe_deposit_address()
                db.execute(
                    "INSERT INTO pickaxe_orders (cash_address,deposit_address,locking_script) VALUES (?,?,?)",
                    (address, deposit, script),
                )
                row = (deposit, 0, None)
        return {"address": row[0], "unlocked": bool(row[1]), "pending": bool(row[2]) and not bool(row[1])}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except (RewardDatabaseError, RuntimeError, sqlite3.Error) as exc:
        logger.error("Pickaxe order unavailable: %s", type(exc).__name__)
        raise HTTPException(status_code=503, detail="Pickaxe order unavailable.") from exc


@app.post("/api/pickaxe/claim")
def pickaxe_claim(request: PickaxeClaimRequest) -> dict:
    try:
        address, _, _ = validate_token_aware_cashaddr(request.cash_address)
        if not TXID_RE.fullmatch(request.txid):
            raise ValueError("Invalid transaction ID.")
        txid = request.txid.lower()
        with open_db(timeout=30) as db:
            row = db.execute(
                "SELECT locking_script,txid,unlocked FROM pickaxe_orders WHERE cash_address=?", (address,)
            ).fetchone()
            if row is None:
                raise HTTPException(status_code=404, detail="Pickaxe order not found.")
            if row[2]:
                return {"unlocked": True}
            confirmed = verify_pickaxe_payment(txid, row[0])
            db.execute(
                "UPDATE pickaxe_orders SET txid=?,unlocked=? WHERE cash_address=? AND unlocked=0",
                (txid, int(confirmed), address),
            )
        return {"unlocked": confirmed}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except (RewardDatabaseError, RuntimeError, sqlite3.Error) as exc:
        logger.error("Pickaxe payment verification failed: %s", type(exc).__name__)
        raise HTTPException(status_code=503, detail="Pickaxe payment verification unavailable.") from exc


@app.get("/api/pickaxe/status")
def pickaxe_status(address: str) -> dict:
    try:
        address, _, _ = validate_token_aware_cashaddr(address)
        with open_db(timeout=30) as db:
            row = db.execute(
                "SELECT locking_script,txid,unlocked FROM pickaxe_orders WHERE cash_address=?", (address,)
            ).fetchone()
            if row is None:
                return {"unlocked": False}
            if row[2]:
                return {"unlocked": True}
            if row[1] and verify_pickaxe_payment(row[1], row[0]):
                db.execute("UPDATE pickaxe_orders SET unlocked=1 WHERE cash_address=?", (address,))
                return {"unlocked": True}
        return {"unlocked": False}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except (RewardDatabaseError, RuntimeError, sqlite3.Error) as exc:
        logger.error("Pickaxe status unavailable: %s", type(exc).__name__)
        raise HTTPException(status_code=503, detail="Pickaxe status unavailable.") from exc


def _satoshis(amount) -> int:
    value = Decimal(str(amount)) * 100_000_000
    if value != value.to_integral_value() or value < 0:
        raise RuntimeError("BCHN returned an invalid UTXO amount.")
    return int(value)


def check_balance() -> int:
    """Return the payout wallet's BCH balance in satoshis for backend use."""
    return _satoshis(bch_rpc("getbalance", [], wallet=True))


@app.get("/api/payout-balance")
def payout_balance() -> dict[str, str]:
    try:
        return {"satoshis": str(check_balance())}
    except (RuntimeError, ValueError, TypeError) as exc:
        logger.warning("Payout balance unavailable: %s", type(exc).__name__)
        raise HTTPException(status_code=503, detail="Payout balance unavailable.") from exc


def _bch_amount(satoshis: int) -> str:
    return f"{satoshis // 100_000_000}.{satoshis % 100_000_000:08d}"


def payout_failure_reason(exc: Exception) -> str:
    safe_messages = {
        "Could not communicate with BCHN.",
        "BCHN returned an HTTP error.",
        "No spendable fungible reward tokens are available.",
        "Insufficient BCH for the reward transaction.",
        "A signed wallet payout requires recovery.",
        "A signed mining payout requires recovery.",
        "BCHN could not fully sign the reward transaction.",
        "Reward transaction fee is below one satoshi per byte.",
    }
    return str(exc) if isinstance(exc, RuntimeError) and str(exc) in safe_messages else type(exc).__name__


def ensure_no_pending_signed_payout() -> None:
    with open_db(timeout=10) as db:
        if db.execute(
            "SELECT 1 FROM token_rewards WHERE signed_tx IS NOT NULL AND sent_at IS NULL LIMIT 1"
        ).fetchone():
            raise RuntimeError("A signed wallet payout requires recovery.")
    if NETCRAFT_MINING_REWARDS_ENABLED == "true":
        with open_db(timeout=10) as db:
            if db.execute(
                "SELECT 1 FROM mining_rewards WHERE signed_tx IS NOT NULL AND sent_at IS NULL LIMIT 1"
            ).fetchone():
                raise RuntimeError("A signed mining payout requires recovery.")


def mining_recipient_dust(address: str) -> int:
    result = bch_rpc("validateaddress", [address])
    script_hex = result.get("scriptPubKey") if isinstance(result, dict) and result.get("isvalid") is True else None
    try:
        script = bytes.fromhex(script_hex)
    except (TypeError, ValueError) as exc:
        raise RuntimeError("BCHN returned an invalid reward address.") from exc
    standard = (
        len(script) == 25 and script[:3] == b"\x76\xa9\x14" and script[-2:] == b"\x88\xac"
        or len(script) == 23 and script[:2] == b"\xa9\x14" and script[-1:] == b"\x87"
        or len(script) == 35 and script[:2] == b"\xaa\x20" and script[-1:] == b"\x87"
    )
    if not standard:
        raise RuntimeError("BCHN returned a nonstandard reward address script.")
    # One fungible token uses a 35-byte token prefix, followed by the locking script.
    output_size = 8 + 1 + 35 + len(script)
    return 3 * (output_size + 148)


def build_reward_transaction(address: str, category: str, *, mining: bool = False) -> tuple[str, str]:
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
    recipient_value = mining_recipient_dust(address) if mining else 1000
    output_value = recipient_value + 1000 * bool(token_change)
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
        address: {"amount": _bch_amount(recipient_value), "tokenData": {"category": category, "amount": "1"}}
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
            ensure_no_pending_signed_payout()
            signed_tx, txid = build_reward_transaction(address, category)
            db.execute(
                f"UPDATE {table} SET signed_tx = ?, txid = ? WHERE cash_address = ?",
                (signed_tx, txid, address),
            )
            # Persist the exact transaction before any broadcast, so retries cannot
            # accidentally create a second payment after an ambiguous RPC failure.
            db.commit()
            return True
        broadcast_reward(bch_rpc, signed_tx, txid)
        db.execute(
            f"UPDATE {table} SET sent_at = CURRENT_TIMESTAMP WHERE cash_address = ?",
            (address,),
        )
        return True


def process_one_mining_reward(reward_id: int | None = None) -> bool:
    if NETCRAFT_MINING_REWARDS_ENABLED != "true":
        return False
    with open_db(timeout=10) as db:
        requested_reward_id = reward_id
        if requested_reward_id is not None:
            existing = db.execute(
                "SELECT sent_at FROM mining_rewards WHERE id = ?", (requested_reward_id,)
            ).fetchone()
            if not existing:
                raise RuntimeError("Mining reward not found.")
            if existing[0] is not None:
                return True
            row = db.execute(
                "SELECT id, cash_address, category, signed_tx, txid FROM mining_rewards WHERE id = ? AND sent_at IS NULL",
                (requested_reward_id,),
            ).fetchone()
        else:
            rows = db.execute(
                """SELECT m.id, m.cash_address, m.category, m.signed_tx, m.txid
                   FROM mining_rewards AS m WHERE m.sent_at IS NULL
                   AND (COALESCE(m.signed_tx, '') <> '' OR NOT EXISTS (
                       SELECT 1 FROM token_rewards AS w
                       WHERE w.cash_address = m.cash_address AND w.sent_at IS NULL
                   ))
                   ORDER BY m.signed_tx IS NULL, m.id LIMIT 1"""
            )
            row = rows.fetchone()
        if not row:
            return False
        reward_id, address, category, signed_tx, txid = row
        validate_token_aware_cashaddr(address)
        if not CATEGORY_RE.fullmatch(category):
            raise RuntimeError("Invalid mining reward category.")
        if not signed_tx:
            if db.execute(
                "SELECT 1 FROM token_rewards WHERE cash_address = ? AND sent_at IS NULL",
                (address,),
            ).fetchone():
                raise RuntimeError("The welcome reward must be sent before mining rewards.")
            ensure_no_pending_signed_payout()
            signed_tx, txid = build_reward_transaction(address, category, mining=True)
            db.execute(
                """UPDATE mining_rewards SET signed_tx = ?, txid = ?
                   WHERE id = ? AND signed_tx IS NULL AND sent_at IS NULL""",
                (signed_tx, txid, reward_id),
            )
            db.commit()
        broadcast_reward(bch_rpc, signed_tx, txid)
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
                with reward_payout_lock:
                    processed = process() or processed
            except (RewardDatabaseError, RuntimeError, sqlite3.Error, ValueError, KeyError, TypeError) as exc:
                logger.error("Could not process %s (%s); it will be retried.", name, payout_failure_reason(exc))
        if not processed:
            reward_wake.wait(30)


def require_netcraft_auth(request: Request) -> None:
    provided = request.headers.get("authorization", "")
    if not NETCRAFT_REWARD_WAKE_SECRET or not secrets.compare_digest(
        provided.encode("utf-8"), f"Bearer {NETCRAFT_REWARD_WAKE_SECRET}".encode("utf-8")
    ):
        raise HTTPException(status_code=403, detail="Forbidden")


class NetcraftAdminProof(BaseModel):
    address: str = Field(min_length=1, max_length=120)
    nonce: str = Field(pattern=r"^[0-9a-f]{64}$", min_length=64, max_length=64)
    signature: str = Field(pattern=r"^[A-Za-z0-9+/]{87}=$", min_length=88, max_length=88)


@app.post("/api/internal/netcraft-admin-proof", status_code=204)
def netcraft_admin_proof(proof: NetcraftAdminProof, request: Request) -> Response:
    require_netcraft_auth(request)
    try:
        claimed, prefix, claimed_type = validate_token_aware_cashaddr(proof.address)
        claimed_payload = claimed.split(":")[1][:-8]
        if claimed_type != 2 or len(claimed_payload) != 34:
            raise ValueError("Not a 20-byte P2PKH wallet")
        # Convert token-aware P2PKH to ordinary P2PKH for BCHN message verification.
        payload = "q" + claimed_payload[1:]
        checksum = _polymod(_prefix_expand(prefix) + [_CHARSET_MAP[c] for c in payload] + [0] * 8)
        address = prefix + ":" + payload + "".join(_CHARSET[(checksum >> shift) & 31]
                                                  for shift in range(35, -1, -5))
    except ValueError as exc:
        raise HTTPException(status_code=403, detail="Admin wallet verification failed") from exc
    try:
        verified = bch_rpc("verifymessage", [
            address, proof.signature, f"CashCraft wallet login v1: {proof.nonce}",
        ])
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail="Wallet verification unavailable") from exc
    if verified is not True:
        raise HTTPException(status_code=403, detail="Admin wallet verification failed")
    configured = os.getenv("NETCRAFT_ADMIN_BCH_ADDRESS", "").strip()
    try:
        configured_address, configured_prefix, configured_type = validate_cashaddr(configured, token_aware=False)
    except ValueError:
        return Response(status_code=202)
    is_admin = (
        configured_prefix == prefix
        and configured_type in (0, 2)
        and configured_address.split(":")[1][1:-8] == claimed_payload[1:]
    )
    return Response(status_code=204 if is_admin else 202)


@app.get("/api/internal/netcraft-mempool")
def netcraft_mempool(request: Request) -> Response:
    require_netcraft_auth(request)
    try:
        txids = bch_rpc("getrawmempool", [False])
        if not isinstance(txids, list) or not all(
            isinstance(txid, str) and TXID_RE.fullmatch(txid) for txid in txids
        ):
            raise RuntimeError("Invalid BCHN mempool response")
    except RuntimeError as exc:
        logger.warning("NetCraft mempool snapshot unavailable")
        raise HTTPException(status_code=503, detail="Mempool unavailable") from exc
    return Response(
        "".join(f"{txid.lower()}\n" for txid in txids),
        media_type="text/plain",
        headers={"Cache-Control": "no-store"},
    )


@app.get("/api/internal/netcraft-tip")
def netcraft_tip(request: Request) -> Response:
    require_netcraft_auth(request)
    try:
        info = bch_rpc("getblockchaininfo", [])
        tip = info.get("bestblockhash") if isinstance(info, dict) else None
        if not isinstance(tip, str) or not TXID_RE.fullmatch(tip) or info.get("initialblockdownload") is not False:
            raise RuntimeError("BCHN tip unavailable or syncing")
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail="BCH tip unavailable") from exc
    return Response(f"{tip.lower()}\n", media_type="text/plain", headers={"Cache-Control": "no-store"})


@app.post("/api/internal/netcraft-reward-wake", status_code=204)
def wake_mining_rewards(request: Request) -> Response:
    require_netcraft_auth(request)
    reward_wake.set()
    return Response(status_code=204)


@app.post("/api/internal/netcraft-mining-reward/{reward_id}", status_code=204)
def pay_mining_reward(reward_id: int, request: Request) -> Response:
    require_netcraft_auth(request)
    if reward_id <= 0:
        raise HTTPException(status_code=400, detail="Invalid reward ID.")
    if NETCRAFT_MINING_REWARDS_ENABLED != "true":
        raise HTTPException(status_code=503, detail="Mining payouts are disabled.")
    try:
        with reward_payout_lock:
            paid = process_one_mining_reward(reward_id)
        if not paid:
            reward_wake.set()
            return Response(status_code=202)
    except (RuntimeError, sqlite3.Error, ValueError, KeyError, TypeError) as exc:
        logger.error("Could not pay mining reward %s (%s); queued for retry.", reward_id, payout_failure_reason(exc))
        reward_wake.set()
        return Response(status_code=202)
    return Response(status_code=204)


@app.get("/api/mina-rewards-sent")
def mina_rewards_sent() -> dict:
    try:
        with open_db(timeout=5) as db:
            total = db.execute(
                "SELECT COUNT(*) FROM token_rewards WHERE category = ? AND sent_at IS NOT NULL",
                (BCH_REWARD_CATEGORY,),
            ).fetchone()[0]
            total += db.execute(
                "SELECT COUNT(*) FROM mining_rewards WHERE category = ? AND sent_at IS NOT NULL",
                (BCH_REWARD_CATEGORY,),
            ).fetchone()[0]
    except (RewardDatabaseError, sqlite3.Error) as exc:
        logger.error("Could not read MINA payout total: %s", type(exc).__name__)
        raise HTTPException(status_code=503, detail="Payout total unavailable") from exc
    return {"sent": str(total)}


@app.get("/api/mina-ranking")
def mina_ranking() -> dict:
    try:
        with open_db(timeout=5) as db:
            columns = {row[1] for row in db.execute("PRAGMA table_info(mining_rewards)")}
            if not {"category", "sent_at"} <= columns:
                raise sqlite3.DatabaseError("Mining rewards table unavailable")
            name = "COALESCE(NULLIF(player_name, ''), 'Unknown player')" if "player_name" in columns else "'Unknown player'"
            rows = db.execute(
                f"SELECT {name} AS player, COUNT(*) AS rewards FROM mining_rewards "
                "WHERE category = ? AND sent_at IS NOT NULL GROUP BY player "
                "ORDER BY rewards DESC, player COLLATE NOCASE LIMIT 20",
                (BCH_REWARD_CATEGORY,),
            ).fetchall()
    except (RewardDatabaseError, sqlite3.Error) as exc:
        logger.error("Could not read MINA ranking: %s", type(exc).__name__)
        raise HTTPException(status_code=503, detail="Ranking unavailable.") from exc
    return {"players": [{"name": name, "rewards": count} for name, count in rows]}


@app.get("/api/ore-ranking")
def ore_ranking() -> dict:
    try:
        with open_db(timeout=5) as db:
            rows = db.execute(
                """SELECT MAX(player_name) AS player,
                          SUM(CASE WHEN ore = 83 THEN blocks ELSE 0 END),
                          SUM(CASE WHEN ore = 73 THEN blocks ELSE 0 END),
                          SUM(CASE WHEN ore = 49 THEN blocks ELSE 0 END),
                          SUM(blocks) AS total
                   FROM ore_scores GROUP BY miner
                   ORDER BY total DESC, player COLLATE NOCASE, miner LIMIT 20"""
            ).fetchall()
    except (RewardDatabaseError, sqlite3.Error) as exc:
        logger.error("Could not read ore ranking: %s", type(exc).__name__)
        raise HTTPException(status_code=503, detail="Ranking unavailable.") from exc
    return {"players": [
        {"name": name, "green": green, "blue": blue, "red": red, "total": total}
        for name, green, blue, red, total in rows
    ]}


@app.get("/api/mina-ore-mined")
def mina_ore_mined() -> dict:
    try:
        with open_db(timeout=5) as db:
            row = db.execute(
                "SELECT total FROM mining_totals WHERE name = 'mina_ore'"
            ).fetchone()
            if row is None:
                raise sqlite3.DatabaseError("Mining total unavailable")
    except (RewardDatabaseError, sqlite3.Error) as exc:
        logger.error("Could not read MINA ore total: %s", type(exc).__name__)
        raise HTTPException(status_code=503, detail="Mining total unavailable.") from exc
    return {"mined": str(row[0])}


@app.get("/api/mina-mined")
def mina_mined(address: str) -> dict:
    try:
        address, _, _ = validate_token_aware_cashaddr(address)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    try:
        with open_db(timeout=5) as db:
            count = db.execute(
                "SELECT COUNT(*) FROM mining_rewards WHERE cash_address = ? "
                "AND category = ? AND sent_at IS NOT NULL",
                (address, BCH_REWARD_CATEGORY),
            ).fetchone()[0]
    except (RewardDatabaseError, sqlite3.Error) as exc:
        logger.error("Could not read mining rewards: %s", type(exc).__name__)
        raise HTTPException(status_code=503, detail="Mining rewards unavailable.") from exc
    return {"mined": count}

