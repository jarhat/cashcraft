from math import floor
from world import World

import argparse
import datetime
import functools
import queue
import random
import re
import requests
import socket
import socketserver
import sqlite3
import threading
import time
import traceback
from concurrent.futures import ThreadPoolExecutor


DEFAULT_HOST = "0.0.0.0"
DEFAULT_PORT = 4080

DB_PATH = "craft.db"
LOG_PATH = "log.txt"

CHUNK_SIZE = 32
BUFFER_SIZE = 4096
MAX_LINE_SIZE = 1000000
COMMIT_INTERVAL = 0.1

# The Python World cache is shared by players. Increase if RAM permits.
WORLD_CACHE_SIZE = 1000000

AUTH_REQUIRED = False
AUTH_URL = "http://127.0.0.1:5000/api/1/access"

DAY_LENGTH = 600
SPAWN_POINT = (-40, 0, 0, 0, 0)
RATE_LIMIT = False
RECORD_HISTORY = True
INDESTRUCTIBLE_ITEMS = {16, 65}
WORLD_MIN_Y = -24
ALLOWED_ITEMS = {
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
    17, 18, 19, 20, 21, 22, 23, 32, 33, 34, 35, 36, 37, 38,
    39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52,
    53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63,
}

# Set this in config.py or pass --seed to keep the same world after restart.
WORLD_SEED = None

AUTHENTICATE = "A"
BLOCK = "B"
CHUNK = "C"
DISCONNECT = "D"
KEY = "K"
LIGHT = "L"
NICK = "N"
POSITION = "P"
REDRAW = "R"
SIGN = "S"
TALK = "T"
TIME = "E"
VERSION = "V"
YOU = "U"

try:
    from config import *
except ImportError:
    pass


def synchronized_state(method):
    """Serialize chunk snapshots with edits to shared world/database state."""
    @functools.wraps(method)
    def wrapper(self, *args, **kwargs):
        with self.chunk_state_lock:
            return method(self, *args, **kwargs)
    return wrapper


def synchronized_edit(method):
    """Serialize an edit with chunk snapshots and commit it when complete."""
    @functools.wraps(method)
    def wrapper(self, *args, **kwargs):
        with self.chunk_state_lock:
            try:
                return method(self, *args, **kwargs)
            finally:
                self.commit()
    return wrapper


def log(*args):
    now = datetime.datetime.utcnow()
    line = " ".join(map(str, (now,) + args))
    print(line)
    try:
        with open(LOG_PATH, "a", encoding="utf-8") as fp:
            fp.write(line + "\n")
    except OSError:
        traceback.print_exc()


def chunked(x):
    """Return the chunk coordinate for a block/world coordinate."""
    return int(floor(float(x) / CHUNK_SIZE))


def packet(*args):
    return ("%s\n" % ",".join(map(str, args))).encode("UTF-8")


class RateLimiter:
    def __init__(self, rate, per):
        self.rate = float(rate)
        self.per = float(per)
        self.allowance = self.rate
        self.last_check = time.time()

    def tick(self):
        if not RATE_LIMIT:
            return False

        now = time.time()
        elapsed = now - self.last_check
        self.last_check = now
        self.allowance = min(
            self.rate,
            self.allowance + elapsed * (self.rate / self.per),
        )

        if self.allowance < 1:
            return True

        self.allowance -= 1
        return False


class Server(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads = True


class Handler(socketserver.BaseRequestHandler):
    def setup(self):
        self.position_limiter = RateLimiter(100, 5)
        self.limiter = RateLimiter(1000, 10)
        self.version = None
        self.client_id = None
        self.user_id = None
        self.nick = None
        self.position = SPAWN_POINT
        self.queue = queue.Queue()
        self.running = True

        # Keep each client's chunk response packets ordered.
        self.chunk_send_lock = threading.Lock()

        # One thread owns socket writes for this client.
        self.sender_thread = threading.Thread(
            target=self.run_sender,
            daemon=True,
        )
        self.sender_thread.start()

    def handle(self):
        model = self.server.model
        model.enqueue(model.on_connect, self)
        buf = b""

        try:
            while True:
                data = self.request.recv(BUFFER_SIZE)
                if not data:
                    break

                buf += data.replace(b"\r\n", b"\n")

                if len(buf) > MAX_LINE_SIZE and b"\n" not in buf:
                    log("OVERSIZE LINE", self.client_id)
                    break

                while b"\n" in buf:
                    index = buf.index(b"\n")
                    line = buf[:index]
                    buf = buf[index + 1:]

                    if not line:
                        continue

                    if len(line) > MAX_LINE_SIZE:
                        log("OVERSIZE LINE", self.client_id)
                        self.stop()
                        return

                    try:
                        command = line.decode("utf-8")
                    except UnicodeDecodeError:
                        log("INVALID UTF8", self.client_id)
                        self.stop()
                        return

                    limiter = (
                        self.position_limiter
                        if command.startswith(POSITION)
                        else self.limiter
                    )

                    if limiter.tick():
                        log("RATE", self.client_id)
                        self.stop()
                        return

                    model.enqueue(model.on_data, self, command)

        except OSError:
            pass
        finally:
            model.enqueue(model.on_disconnect, self)

    def finish(self):
        self.running = False

    def stop(self):
        self.running = False
        try:
            self.request.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        try:
            self.request.close()
        except OSError:
            pass

    def run_sender(self):
        while self.running:
            try:
                data = self.queue.get(timeout=1)
            except queue.Empty:
                continue

            # Coalesce queued packets to reduce socket writes.
            parts = [data]
            total = len(data)

            while total < 256 * 1024:
                try:
                    more = self.queue.get_nowait()
                except queue.Empty:
                    break
                parts.append(more)
                total += len(more)

            try:
                self.request.sendall(b"".join(parts))
            except OSError:
                self.running = False
                try:
                    self.request.close()
                except OSError:
                    pass
                return

    def send_raw(self, data):
        if data and self.running:
            self.queue.put(data)

    def send(self, *args):
        self.send_raw(packet(*args))


class Model:
    def __init__(self, seed):
        self.world = World(seed, cache_size=WORLD_CACHE_SIZE)

        # Chunk generation and database reads happen outside the main model
        # event loop, so a slow chunk won't block chat or player movement.
        self.chunk_pool = ThreadPoolExecutor(
            max_workers=8,
            thread_name_prefix="chunk",
        )
        self.auth_pool = ThreadPoolExecutor(
            max_workers=4,
            thread_name_prefix="auth",
        )

        self.chunk_db = threading.local()
        self.world_lock = threading.Lock()

        # Keep chunk snapshots ordered with edits and their broadcasts.
        self.chunk_state_lock = threading.RLock()

        self.clients = []
        self.queue = queue.Queue()
        self.connection = None
        self.last_commit = time.time()

        self.commands = {
            AUTHENTICATE: self.on_authenticate,
            BLOCK: self.on_block,
            LIGHT: self.on_light,
            POSITION: self.on_position,
            TALK: self.on_talk,
            SIGN: self.on_sign,
            VERSION: self.on_version,
        }

        self.patterns = [
            (re.compile(r"^/nick(?:\s+([^,\s]+))?$"), self.on_nick),
            (re.compile(r"^/spawn$"), self.on_spawn),
            (re.compile(r"^/goto(?:\s+(\S+))?$"), self.on_goto),
            (re.compile(r"^/pq\s+(-?[0-9]+)\s*,?\s*(-?[0-9]+)$"), self.on_pq),
            (re.compile(r"^/help(?:\s+(\S+))?$"), self.on_help),
            (re.compile(r"^/list$"), self.on_list),
        ]

    def start(self):
        threading.Thread(target=self.run, daemon=True).start()

    def run(self):
        self.connection = sqlite3.connect(DB_PATH, timeout=10)
        self.connection.execute("PRAGMA journal_mode = WAL;")
        self.connection.execute("PRAGMA busy_timeout = 10000;")
        self.create_tables()
        self.commit()

        while True:
            try:
                if time.time() - self.last_commit >= COMMIT_INTERVAL:
                    self.commit()
                self.dequeue()
            except Exception:
                traceback.print_exc()

    def enqueue(self, func, *args, **kwargs):
        self.queue.put((func, args, kwargs))

    def dequeue(self):
        try:
            func, args, kwargs = self.queue.get(timeout=1)
        except queue.Empty:
            return

        try:
            func(*args, **kwargs)
        except Exception:
            traceback.print_exc()

    def execute(self, *args, **kwargs):
        return self.connection.execute(*args, **kwargs)

    def commit(self):
        if self.connection is not None:
            self.connection.commit()
        self.last_commit = time.time()

    def create_tables(self):
        queries = [
            """create table if not exists block (
                p int not null, q int not null, x int not null,
                y int not null, z int not null, w int not null
            );""",
            """create unique index if not exists block_pqxyz_idx
               on block (p, q, x, y, z);""",
            """create table if not exists light (
                p int not null, q int not null, x int not null,
                y int not null, z int not null, w int not null
            );""",
            """create unique index if not exists light_pqxyz_idx
               on light (p, q, x, y, z);""",
            """create table if not exists sign (
                p int not null, q int not null, x int not null,
                y int not null, z int not null, face int not null,
                text text not null
            );""",
            "create index if not exists sign_pq_idx on sign (p, q);",
            """create unique index if not exists sign_xyzface_idx
               on sign (x, y, z, face);""",
            """create table if not exists block_history (
                timestamp real not null, user_id int not null,
                x int not null, y int not null, z int not null, w int not null
            );""",
        ]

        for query in queries:
            self.execute(query)

    def get_default_block(self, x, y, z):
        p, q = chunked(x), chunked(z)
        with self.world_lock:
            chunk = self.world.get_chunk(p, q)
            return chunk.get((x, y, z), 0)

    def get_block(self, x, y, z):
        rows = list(self.execute(
            """select w from block
               where p = :p and q = :q and x = :x and y = :y and z = :z;""",
            dict(p=chunked(x), q=chunked(z), x=x, y=y, z=z),
        ))
        if rows:
            return rows[0][0]
        return self.get_default_block(x, y, z)

    def next_client_id(self):
        used = {client.client_id for client in self.clients}
        result = 1
        while result in used:
            result += 1
        return result

    def on_connect(self, client):
        client.client_id = self.next_client_id()
        client.nick = "guest%d" % client.client_id
        client.position = SPAWN_POINT

        log("CONN", client.client_id, *client.client_address)
        self.clients.append(client)

        client.send(YOU, client.client_id, *client.position)
        client.send(TIME, time.time(), DAY_LENGTH)
        client.send(TALK, "Welcome to Craft!")
        client.send(TALK, 'Type "/help" for a list of commands.')
        self.send_position(client)
        self.send_positions(client)
        self.send_nick(client)
        self.send_nicks(client)

    def on_data(self, client, data):
        args = data.split(",")
        command, args = args[0], args[1:]

        if command == CHUNK:
            if len(args) not in (2, 3):
                log("BAD CHUNK REQUEST", client.client_id, data)
                return

            p, q = args[0], args[1]
            key = args[2] if len(args) == 3 else "0"

            future = self.chunk_pool.submit(
                self.on_chunk, client, p, q, key
            )
            future.add_done_callback(self.log_chunk_error)
            return

        handler = self.commands.get(command)
        if handler is not None:
            try:
                handler(client, *args)
            except (TypeError, ValueError) as exc:
                log("BAD COMMAND", client.client_id, data, repr(exc))
            return

        log("UNKNOWN COMMAND", client.client_id, command)

    def log_chunk_error(self, future):
        try:
            error = future.exception()
        except Exception:
            traceback.print_exc()
            return

        if error is not None:
            log("CHUNK ERROR", repr(error))
            traceback.print_exception(
                type(error), error, error.__traceback__
            )

    def on_disconnect(self, client):
        if client.client_id is not None:
            log("DISC", client.client_id, *client.client_address)

        if client in self.clients:
            self.clients.remove(client)
            self.send_disconnect(client)
            self.send_talk("%s has disconnected from the server." % client.nick)

        client.running = False

    def on_version(self, client, version):
        if client.version is not None:
            return
        if int(version) != 1:
            client.stop()
            return
        client.version = 1

    def on_authenticate(self, client, username, access_token):
        if not username or not access_token:
            self.finish_authenticate(client, username, None)
            return

        self.auth_pool.submit(
            self.authenticate_worker,
            client,
            username,
            access_token,
        )

    def authenticate_worker(self, client, username, access_token):
        user_id = None
        try:
            response = requests.post(
                AUTH_URL,
                data={
                    "username": username,
                    "access_token": access_token,
                },
                timeout=10,
            )
            if response.status_code == 200 and response.text.isdigit():
                user_id = int(response.text)
        except requests.RequestException as exc:
            log("AUTH ERROR", repr(exc))

        self.enqueue(self.finish_authenticate, client, username, user_id)

    def finish_authenticate(self, client, username, user_id):
        if not client.running:
            return

        client.user_id = user_id
        if user_id is None:
            client.nick = "guest%d" % client.client_id
            client.send(TALK, "Visit craft.michaelfogleman.com to register!")
        else:
            client.nick = username

        self.send_nick(client)
        self.send_talk("%s has joined the game." % client.nick)

    def get_chunk_connection(self):
        connection = getattr(self.chunk_db, "connection", None)
        if connection is None:
            connection = sqlite3.connect(DB_PATH, timeout=10)
            connection.execute("PRAGMA busy_timeout = 10000;")
            self.chunk_db.connection = connection
        return connection

    def on_chunk(self, client, p, q, key=0):
        if not client.running:
            return

        try:
            p, q, key = map(int, (p, q, key))
        except (TypeError, ValueError):
            log("BAD CHUNK COORDINATES", client.client_id, p, q, key)
            return

        # Preserve the order of each client's chunk responses.
        with client.chunk_send_lock:
            self.send_chunk(client, p, q, key)

    @synchronized_state
    def send_chunk(self, client, p, q, key=0):
        if not client.running:
            return

        connection = self.get_chunk_connection()
        packets = bytearray()
        max_rowid = key
        terrain_count = 0

        # Keep a chunk response and its completion markers together in the
        # client's outgoing queue. This prevents other packets from splitting
        # the terrain data from its KEY/REDRAW/CHUNK markers.
        def append_packet(*args):
            packets.extend(packet(*args))

        # A zero key means the client needs the generated base terrain.
        if key == 0:
            with self.world_lock:
                terrain = list(self.world.get_chunk(p, q).items())

            min_x = p * CHUNK_SIZE
            min_z = q * CHUNK_SIZE
            max_x = min_x + CHUNK_SIZE
            max_z = min_z + CHUNK_SIZE

            for (x, y, z), w in terrain:
                if min_x <= x < max_x and min_z <= z < max_z and w > 0:
                    append_packet(BLOCK, p, q, x, y, z, w)
                    terrain_count += 1

        # For a cached chunk, send only changes newer than its key.
        for rowid, x, y, z, w in connection.execute(
            """select rowid, x, y, z, w from block
               where p = :p and q = :q and rowid > :key
               order by rowid;""",
            dict(p=p, q=q, key=key),
        ):
            append_packet(BLOCK, p, q, x, y, z, w)
            max_rowid = max(max_rowid, rowid)

        for x, y, z, w in connection.execute(
            """select x, y, z, w from light
               where p = :p and q = :q;""",
            dict(p=p, q=q),
        ):
            append_packet(LIGHT, p, q, x, y, z, w)

        for x, y, z, face, text in connection.execute(
            """select x, y, z, face, text from sign
               where p = :p and q = :q;""",
            dict(p=p, q=q),
        ):
            append_packet(SIGN, p, q, x, y, z, face, text)

        # Client uses these markers to finish and redraw the chunk.
        append_packet(KEY, p, q, max_rowid)
        append_packet(REDRAW, p, q)
        append_packet(CHUNK, p, q)

        if packets:
            client.send_raw(bytes(packets))

        log(
            "CHUNK SENT",
            client.client_id,
            p,
            q,
            "terrain",
            terrain_count,
            "key",
            max_rowid,
        )

    @synchronized_edit
    def on_block(self, client, x, y, z, w):
        x, y, z, w = map(int, (x, y, z, w))
        p, q = chunked(x), chunked(z)
        previous = self.get_block(x, y, z)
        message = None

        if AUTH_REQUIRED and client.user_id is None:
            message = "Only logged in users are allowed to build."
        elif y <= WORLD_MIN_Y or y > 255:
            message = "Invalid block coordinates."
        elif w not in ALLOWED_ITEMS:
            message = "That item is not allowed."
        elif w and previous:
            message = "Cannot create blocks in a non-empty space."
        elif not w and not previous:
            message = "That space is already empty."
        elif previous in INDESTRUCTIBLE_ITEMS or (y < 0 and previous in (12, 13)):
            message = "Cannot destroy that type of block."

        if message:
            client.send(BLOCK, p, q, x, y, z, previous)
            client.send(REDRAW, p, q)
            client.send(TALK, message)
            return

        if RECORD_HISTORY:
            self.execute(
                """insert into block_history
                   (timestamp, user_id, x, y, z, w)
                   values (:timestamp, :user_id, :x, :y, :z, :w);""",
                dict(
                    timestamp=time.time(),
                    user_id=client.user_id or 0,
                    x=x,
                    y=y,
                    z=z,
                    w=w,
                ),
            )

        self.execute(
            """insert or replace into block (p, q, x, y, z, w)
               values (:p, :q, :x, :y, :z, :w);""",
            dict(p=p, q=q, x=x, y=y, z=z, w=w),
        )
        self.send_block(client, p, q, x, y, z, w)

        # Store boundary updates in neighboring chunks.
        for dx in range(-1, 2):
            for dz in range(-1, 2):
                if dx == 0 and dz == 0:
                    continue
                if dx and chunked(x + dx) == p:
                    continue
                if dz and chunked(z + dz) == q:
                    continue

                np, nq = p + dx, q + dz
                self.execute(
                    """insert or replace into block (p, q, x, y, z, w)
                       values (:p, :q, :x, :y, :z, :w);""",
                    dict(p=np, q=nq, x=x, y=y, z=z, w=-w),
                )
                self.send_block(client, np, nq, x, y, z, -w)

        if w == 0:
            self.execute(
                """delete from sign
                   where x = :x and y = :y and z = :z;""",
                dict(x=x, y=y, z=z),
            )
            self.execute(
                """update light set w = 0
                   where x = :x and y = :y and z = :z;""",
                dict(x=x, y=y, z=z),
            )

    @synchronized_edit
    def on_light(self, client, x, y, z, w):
        x, y, z, w = map(int, (x, y, z, w))
        p, q = chunked(x), chunked(z)
        block = self.get_block(x, y, z)
        message = None

        if AUTH_REQUIRED and client.user_id is None:
            message = "Only logged in users are allowed to build."
        elif block == 0:
            message = "Lights must be placed on a block."
        elif w < 0 or w > 15:
            message = "Invalid light value."

        if message:
            client.send(REDRAW, p, q)
            client.send(TALK, message)
            return

        self.execute(
            """insert or replace into light (p, q, x, y, z, w)
               values (:p, :q, :x, :y, :z, :w);""",
            dict(p=p, q=q, x=x, y=y, z=z, w=w),
        )
        self.send_light(client, p, q, x, y, z, w)

    @synchronized_edit
    def on_sign(self, client, x, y, z, face, *args):
        if AUTH_REQUIRED and client.user_id is None:
            client.send(TALK, "Only logged in users are allowed to build.")
            return

        text = ",".join(args)
        x, y, z, face = map(int, (x, y, z, face))

        if y <= WORLD_MIN_Y or y > 255 or face < 0 or face > 7 or len(text) > 48:
            return

        p, q = chunked(x), chunked(z)

        if text:
            self.execute(
                """insert or replace into sign
                   (p, q, x, y, z, face, text)
                   values (:p, :q, :x, :y, :z, :face, :text);""",
                dict(
                    p=p,
                    q=q,
                    x=x,
                    y=y,
                    z=z,
                    face=face,
                    text=text,
                ),
            )
        else:
            self.execute(
                """delete from sign
                   where x = :x and y = :y and z = :z and face = :face;""",
                dict(x=x, y=y, z=z, face=face),
            )

        self.send_sign(client, p, q, x, y, z, face, text)

    def on_position(self, client, x, y, z, rx, ry):
        client.position = tuple(map(float, (x, y, z, rx, ry)))
        self.send_position(client)

    def on_talk(self, client, *args):
        text = ",".join(args)

        if text.startswith("/"):
            for pattern, func in self.patterns:
                match = pattern.match(text)
                if match:
                    func(client, *match.groups())
                    break
            else:
                client.send(TALK, 'Unrecognized command: "%s"' % text)

        elif text.startswith("@"):
            nick = text[1:].split(" ", 1)[0]
            for other in self.clients:
                if other.nick == nick:
                    client.send(TALK, "%s> %s" % (client.nick, text))
                    other.send(TALK, "%s> %s" % (client.nick, text))
                    break
            else:
                client.send(TALK, 'Unrecognized nick: "%s"' % nick)

        else:
            self.send_talk("%s> %s" % (client.nick, text))

    def on_nick(self, client, nick=None):
        if AUTH_REQUIRED:
            client.send(TALK, "You cannot change your nick on this server.")
        elif nick is None:
            client.send(TALK, "Your nickname is %s" % client.nick)
        else:
            self.send_talk("%s is now known as %s" % (client.nick, nick))
            client.nick = nick
            self.send_nick(client)

    def on_spawn(self, client):
        client.position = SPAWN_POINT
        client.send(YOU, client.client_id, *client.position)
        self.send_position(client)

    def on_goto(self, client, nick=None):
        if nick is None:
            others = [x for x in self.clients if x != client]
            other = random.choice(others) if others else None
        else:
            other = next((x for x in self.clients if x.nick == nick), None)

        if other:
            client.position = other.position
            client.send(YOU, client.client_id, *client.position)
            self.send_position(client)

    def on_pq(self, client, p, q):
        p, q = map(int, (p, q))
        client.position = (p * CHUNK_SIZE, 0, q * CHUNK_SIZE, 0, 0)
        client.send(YOU, client.client_id, *client.position)
        self.send_position(client)

    def on_help(self, client, topic=None):
        if topic is None:
            client.send(TALK, 'Type "t" to chat. Type "/" to type commands:')
            client.send(
                TALK,
                "/goto [NAME], /help [TOPIC], /list, /login NAME, "
                "/logout, /nick",
            )
            client.send(
                TALK,
                "/offline [FILE], /online HOST [PORT], "
                "/pq P Q, /spawn, /view N",
            )
            return

        topic = topic.lower().strip()
        help_lines = {
            "goto": (
                "Help: /goto [NAME]",
                "Teleport to another user.",
                "If NAME is unspecified, a random user is chosen.",
            ),
            "list": (
                "Help: /list",
                "Display a list of connected users.",
            ),
            "login": (
                "Help: /login NAME",
                "Switch to another registered username.",
                "The login server will be re-contacted. "
                "The username is case-sensitive.",
            ),
            "logout": (
                "Help: /logout",
                "Unauthenticate and become a guest user.",
                "Automatic logins will not occur again until /login is re-issued.",
            ),
            "offline": (
                "Help: /offline [FILE]",
                "Switch to offline mode.",
                'FILE specifies the save file and defaults to "craft".',
            ),
            "online": (
                "Help: /online HOST [PORT]",
                "Connect to the specified server.",
            ),
            "nick": (
                "Help: /nick [NICK]",
                "Get or set your nickname.",
            ),
            "pq": (
                "Help: /pq P Q",
                "Teleport to the specified chunk.",
            ),
            "spawn": (
                "Help: /spawn",
                "Teleport back to the spawn point.",
            ),
            "view": (
                "Help: /view N",
                "Set viewing distance, 1 - 24.",
            ),
        }

        for line in help_lines.get(topic, ()):
            client.send(TALK, line)

    def on_list(self, client):
        client.send(TALK, "Players: %s" % ", ".join(x.nick for x in self.clients))

    def send_positions(self, client):
        for other in self.clients:
            if other != client:
                client.send(POSITION, other.client_id, *other.position)

    def send_position(self, client):
        for other in self.clients:
            if other != client:
                other.send(POSITION, client.client_id, *client.position)

    def send_nicks(self, client):
        for other in self.clients:
            if other != client:
                client.send(NICK, other.client_id, other.nick)

    def send_nick(self, client):
        for other in self.clients:
            other.send(NICK, client.client_id, client.nick)

    def send_disconnect(self, client):
        for other in self.clients:
            if other != client:
                other.send(DISCONNECT, client.client_id)

    def send_block(self, client, p, q, x, y, z, w):
        for other in self.clients:
            if other != client:
                other.send(BLOCK, p, q, x, y, z, w)
                other.send(REDRAW, p, q)

    def send_light(self, client, p, q, x, y, z, w):
        for other in self.clients:
            if other != client:
                other.send(LIGHT, p, q, x, y, z, w)
                other.send(REDRAW, p, q)

    def send_sign(self, client, p, q, x, y, z, face, text):
        for other in self.clients:
            if other != client:
                other.send(SIGN, p, q, x, y, z, face, text)

    def send_talk(self, text):
        log(text)
        for client in self.clients:
            client.send(TALK, text)


def main():
    parser = argparse.ArgumentParser(description="Netcraft multiplayer server")
    parser.add_argument("--host", default=DEFAULT_HOST)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--seed", type=int, default=None)
    args = parser.parse_args()

    seed = args.seed if args.seed is not None else WORLD_SEED
    model = Model(seed)
    model.start()

    with Server((args.host, args.port), Handler) as server:
        server.model = model
        log("LISTEN", args.host, args.port, "seed", seed)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            log("STOP")
        finally:
            server.shutdown()
            server.server_close()
            model.chunk_pool.shutdown(wait=False, cancel_futures=True)
            model.auth_pool.shutdown(wait=False, cancel_futures=True)


if __name__ == "__main__":
    main()
