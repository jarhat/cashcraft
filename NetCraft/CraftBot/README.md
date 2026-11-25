CraftBot
========

Python 3 bots for NetCraft's native TCP server. From the repository root,
start a local server if one isn't already running:

```sh
cargo run --release --manifest-path NetCraft/server/Cargo.toml
```

In another terminal, run **one** of these commands:

```sh
python3 NetCraft/CraftBot/snakebot.py localhost 4080
python3 NetCraft/CraftBot/makerbot.py localhost 4080
python3 NetCraft/CraftBot/terraformbot.py localhost 4080
python3 NetCraft/CraftBot/humanoidbot.py localhost 4080
```

Host and port are optional and default to `localhost 4080`. The bot joins as
a guest with its class name as its nickname; use `--nick NAME` to override.
Use `/list` in game to see it, and Ctrl+C in the bot terminal to disconnect.
No account or pip packages are needed. Terrain operations need a C compiler
(`cc`, or set `CC`) on Linux to build the matching generator on first use.

Use a reachable TCP address, not the browser's `/craftws` URL. The default
Compose deployment does not publish port 4080 to the host; on its app
network the server address is `netcraft 4080`.

The humanoid stands guard on the ground near spawn, swinging at nearby zombies at night and
idling during the day. Compose starts one guard and three workers of each
other type by default. Set `NETCRAFT_HUMANOIDBOT_COUNT`, `NETCRAFT_SNAKEBOT_COUNT`,
`NETCRAFT_MAKERBOT_COUNT`, and `NETCRAFT_TERRAFORMBOT_COUNT` in the root `.env` to nonnegative integers;
zero disables that type. Run `docker compose up -d --build` to apply the
counts. Each replica joins `netcraft:4080` with a nickname derived from its
container ID and restarts on disconnect. Leave room for human players within
the server's 64-client limit.

Screenshots
===========
<img src="https://raw.github.com/ryansturmer/CraftBot/master/screenshots/snakebot.png">
