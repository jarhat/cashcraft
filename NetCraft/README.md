NetCraft
========

Voxel game for modern web browsers (Chrome, Firefox, Safari) and desktop operating systems (Windows, macOS, Linux).
The C client uses OpenGL/WebGL shaders and connects to the included Rust
multiplayer server through TCP or WebSockets.

**Live demo: https://satoshinm.github.io/NetCraft/**

[![CircleCI](https://circleci.com/gh/satoshinm/NetCraft.svg?style=svg)](https://circleci.com/gh/satoshinm/NetCraft)

[![AppVeyor](https://ci.appveyor.com/api/projects/status/asql58oxt14pfva4?svg=true)](https://ci.appveyor.com/project/satoshinm/netcraft)

Based on Michael Fogleman's [Craft](https://github.com/fogleman/Craft):

http://www.michaelfogleman.com/craft/

Supports running in a web browser with WebGL (built using emscripten), including multiplayer through WebSockets:

![Screenshot](http://i.imgur.com/Fw2wQL7.png)

and also natively, as with the original Craft:

![Screenshot](http://i.imgur.com/SH7wcas.png)

### Features

* Simple but nice looking terrain generation using perlin / simplex noise.
* More than 10 types of blocks and more can be added easily.
* Supports plants (grass, flowers, trees, etc.) and transparency (glass).
* Voxel clouds that drift across the sky.
* Day / night cycles and a textured sky dome.
* Classic rolling hills blended into regional biomes. Deep caves lead through
  openings in the bedrock into caverns with animated water and lava streams.
  Shafts in the cavern floor expose a deeper, lethal lava layer.
* Spawn in the jungle near the western desert and its palm trees. Two large
  valley lakes provide swimming and browser splash sounds.
* World changes persisted in a sqlite3 database.
* Multiplayer support!

### Download

JavaScript, WebAssembly, and Linux builds are available from CircleCI: https://circleci.com/gh/satoshinm/NetCraft

Windows builds are available from AppVeyor: https://ci.appveyor.com/project/satoshinm/netcraft

See below to run from source.

### Web builds

To build for the web, compiling to JavaScript, first install [Emscripten](http://emscripten.org).
The EM SDK is the easiest to install, but to get my patch fixes you can either build from source
using this branch: https://github.com/satoshinm/emscripten/commits/netcraft, or alternatively
install 1.37.12 from the SDK and apply a patch:

    patch -p1 -d $EMSCRIPTEN < src/emscripten-1.37.12+netcraftfixes.patch

Once your Emscripten environment is setup, then run:

    git clone https://github.com/satoshinm/NetCraft.git
    cd NetCraft
    mkdir build
    cmake -DCMAKE_TOOLCHAIN_FILE=$EMSCRIPTEN/cmake/Modules/Platform/Emscripten.cmake ..
    make

then open craft.html in your HTML5/WebGL-compatible web browser, and it will load craft.js. The game should
function similarly to the native build (see below).

Web-specific code is marked in the C source with `#ifdef __EMSCRIPTEN__`.


#### Optimized web builds

The default emscripten build configuration is unoptimized, for ease of development, but you
can optimize using `-DCMAKE_BUILD_TYPE=Release` to cmake, for example:

    mkdir release-build-js
    cmake -DCMAKE_BUILD_TYPE=Release -DCMAKE_TOOLCHAIN_FILE=$EMSCRIPTEN/cmake/Modules/Platform/Emscripten.cmake ..
    make

This process takes longer, but generates a minified craft.js (using `-O3` to emcc), several
times smaller. The optimized builds may require running from a web server instead
of a local file due to origin restrictions, an easy way to do this is using Python:

    python -m SimpleHTTPServer

then browsing to http://localhost:8000/craft.html.

#### WebAssembly web build

Finally to enable the use of [WebAssembly](http://webassembly.org) (through
emscripten's `-s WASM` flag to emcc), pass `-DWASM=1` to cmake:

    mkdir wasm-build
    cmake -DWASM=1 -DCMAKE_BUILD_TYPE=Release -DCMAKE_TOOLCHAIN_FILE=$EMSCRIPTEN/cmake/Modules/Platform/Emscripten.cmake ..
    make

This creates a binary file `craft.wasm` with the bulk of the application code,
instead of JavaScript, for better performance. Note not all browsers support WebAssembly yet (check [caniuse](https://caniuse.com/#feat=wasm))
and this build type should be considered very experimental.

### Native builds

Building natively for desktop operating systems is also supported.

You can have both native and web builds in different directories, building from the same
source. This is useful for testing web-based regressions and ensuring native functionality.
I use the following directories, each you can run `make` from for different build types:

* build
* release-build-js
* wasm-build
* native-build (see below)

#### macOS

Download and install [CMake](http://www.cmake.org/cmake/resources/software.html)
if you don't already have it. You may use [Homebrew](http://brew.sh) to simplify
the installation:

    brew install cmake

You can use `make` or Xcode to compile. To use Xcode, generate the project using:

    mkdir osx
    cd osx
    cmake .. -G "Xcode"

then open the `.xcodeproj` file and choose run.

#### Linux (Ubuntu 16.04.2 LTS)

    sudo apt install cmake libglew-dev xorg-dev libcurl4-openssl-dev
    sudo apt install libglfw3-dev

#### Windows

Download and install [CMake](http://www.cmake.org/cmake/resources/software.html)
and [MinGW](http://www.mingw.org/). Add `C:\MinGW\bin` to your `PATH`.

Download and install [cURL](http://curl.haxx.se/download.html) so that
CURL/lib and CURL/include are in your Program Files directory.

Use the following commands in place of the ones described in the next section.

    cmake -G "MinGW Makefiles"
    mingw32-make

### Compile and Run

Once you have the dependencies (see above), run the following commands in your
terminal.

    mkdir native-build
    cd native-build
    cmake ..
    make
    ./craft

To enable additional compiler debug settings, run cmake with:

    cmake -DDEBUG=1 ..

#### Client

You can connect to a server with command line arguments...

    ./craft craft.michaelfogleman.com

Or, with the "/online" command in the game itself.

    /online craft.michaelfogleman.com

In the web-based version, you can pass command-line arguments after `#` in the URL.


#### Server

Run `cargo run --release --manifest-path server/Cargo.toml` to listen on TCP
port 4080. `NETCRAFT_LISTEN` and `NETCRAFT_DB` override the listen address and
world SQLite database. `CASHADDR_DB_PATH` points to the separate CashAddr SQLite
database (defaults to `cash-addresses.sqlite3` alongside the world file).
See [backend persistence](../backend/README.md) before upgrading an existing
world with mining rewards or stats. The server compiles the same terrain
generator as the client.
Clients generate baseline terrain locally and request persisted edits, so both
must use matching builds. Python-server worlds created with a custom seed
cannot be migrated by copying the database alone.

The repository's Compose setup runs the Rust server behind websockify and an
ACME-enabled HTTPS proxy. Set `NETCRAFT_WS_DOMAIN` to a public DNS name pointing
at the proxy, configure the other required values in `.env`, build the WASM
client into `NETCRAFT_BUILD_PATH`, and start Compose. The frontend is built with
`wss://<NETCRAFT_WS_DOMAIN>/craftws` and connects automatically when NetCraft
opens. Rebuild the frontend after changing the domain. The local client can
also use `/online` and a full WebSocket URL. The server sends an idle heartbeat
to help keep proxy connections open. The browser retries disconnected
connections with backoff and refreshes loaded chunks after reconnecting.
Block edits are paused while disconnected; they are not queued.
Disconnecting a wallet does not close the game; its reward address is cleared
and can be connected again while playing.

Open the trophy to start a **practice challenge**. Verify your wallet, select
other verified players, and wait for at least one to accept before starting.
Shareable links open NetCraft, but only the selected wallets can accept.
For Capture the Flag, the in-game **World view: Top perspective** shows both
flags and follows the carriers; the bases are 28 blocks either side of spawn.
Survival rounds end when one challenger remains. The mining race counts
natural block removals until NetCraft observes a new BCHN tip. Rankings show
currently connected, verified wallets only. Practice rounds restart with the
server and do not accept stakes or pay prizes.

To enable admin tools, set `NETCRAFT_ADMIN_BCH_ADDRESS` to the wallet's
prefixed P2PKH CashAddr (token-aware or standard) in `.env`. Connect that wallet in
CashCraft, register its reward address, and choose **Verify wallet** in the game guide. The
built-in wallet signs the challenge directly; external wallets can paste a
standard BCH signed-message proof. Any online player can double-tap Space
to toggle flight. Verified admins can also use `/noclip` and break mineable
blocks with one press using the admin MINA axe. Reconnecting or changing
wallets requires verification again.
Deploy matching Rust server and game client builds: normal mining now starts
with a timing message before the block edit.
If the world is regenerated while retaining CashAddr reward history, ore at
previously rewarded coordinates is still mineable but does not count toward
another payout.

Players can mine MINA ore without a wallet. Their browser stores a random bearer
identity used to retain server-side progress and unclaimed rewards; clearing
browser storage loses access to them, so keep that identity private. Connecting
a registered token-aware wallet claims pending rewards and merges incomplete
MINA progress into that address. Other ore rewards still require a connected
wallet. On the first mined block without a wallet, a brief reminder appears in
wallet connection details. New rewards and notifications make the game's
wallet button blink green until the wallet is opened.

The CashCraft launcher opens fullscreen from a click where supported. Shared
CashCraft links open the game without requesting browser fullscreen and start
with the wizard's touch controls. Collapse the extra buttons with the toolbar
toggle in windowed play. Fullscreen keeps only the available crafting shortcut
and the minimize button; minimizing preserves the active game.
The wizard shows textured ore counters,
WizardConnect pairing, and the crafting table for the permanent MINA pickaxe.
The combined wizard-and-gem button opens the guide, replays the tutorial, and
provides access to wallet connection and reward notifications.
Browser wallet creation requires a password and confirmation of the recovery
phrase backup. The wallet scans receive and change addresses, rescans after
registration, and refreshes periodically while connected.
The browser wallet's unlocked session survives a refresh in the same tab until
explicitly disconnected or the tab session ends. WizardConnect attempts to
restore its saved pairing; the external wallet may still require approval.
Players have a regular pixel pickaxe in the lower-right corner. When the
connected wallet has at least 2 spendable green MINA and does not already have
the upgrade, the crafting table is highlighted. It prepares a payment of
2 MINA to a unique address in the BCHN payout wallet. Players must connect a
wallet and approve the transfer. After one confirmation, the faster green
pickaxe is permanently unlocked for that registered wallet; it reduces mining
time to one quarter. Pending payments are retried, and the transaction ID can be
entered again if automatic verification fails. Reward delivery still depends
on the payout service.

The fullscreen loading artwork and ring fade after the first frame is rendered.
Both the shared-link loader and the NetCraft client use `/craft-loader.css` and
`/craft-loading.webp`; the NetCraft loader also shows available download progress.
The frontend also serves the touch-button icons
`/pickaxe.svg` and `/grass-block.svg`; deploy it alongside the rebuilt client.
Graphics and runtime errors are reported separately from the server connection, which can
remain connected even if rendering fails. Check the browser console for the
underlying error; a lost WebGL context requires reloading the game. After
changing the client, rebuild the WASM files in `NETCRAFT_BUILD_PATH`; restarting
only the server does not update the browser client.

The server simulates sheep-like animals for mempool transactions near active
players. At night they become upright zombies that pursue and attack nearby
players, climbing and descending one-block steps; at daybreak they become
passive animals again. Aim and use the mining
button or left click to hit a nearby zombie with the pickaxe. The three-segment
bar beside its name shows remaining health. Three hits, shared across attackers,
restore it to animal form for the rest of the night. Health resets at dawn.
Each player starts with 10 lives, shown
as hearts at the bottom center of the screen, and can
lose one every two seconds to zombie attacks. After the last life is lost, the
player respawns at spawn with 10 lives. When the sky island plaza is installed,
wildlife and transaction animals spawn on it while players are nearby. Movement and attacks are
shared by the server and follow terrain and block edits. Separate, sparse wildlife
includes rainforest monkeys and tigers, desert elephants and giraffes, temperate
deer, and taiga foxes. They never become zombies; only tigers attack nearby players.
Animals despawn when no
players are nearby and are not persisted across server restarts.

### Preview-inspired world

Terrain generation is shared by the client and server. When upgrading, rebuild
both together. Saved block edits are preserved, but the terrain underneath those
edits is regenerated. The caverns below the bedrock roof have terraced floors,
wider water pools, and red lava basins. On the Rust server, breaking a bank lets
liquid spill into excavated passages. It drops first, then spreads sideways,
up to seven blocks for water and three for lava. Blocks can dam either liquid.
Lava burns through a full health bar in about a second; stay clear of the banks.

With the server stopped, run from the repository root:

```sh
python3 NetCraft/builder.py
```

This requires Python 3 and a C compiler and creates `data/netcraft.db` for
Compose. It adds a central park, a dragon with larger ribbed wings and a
curved tail, a green coin, and eight bridge-linked islands. The four outer
islands, 108 blocks from the park center, feature a glass observatory, a
lagoon and waterfall, ruined arches, and a grove. The park is at `y=180`;
only verified admins can fly up using double-tap Space. To add
the donation QR, set `DONATION_ADDRESS` in `builder.py` to the desired address
and install Python's `segno` package before building. The QR is omitted when
the address is blank. Check it with a phone in the actual game before use;
lighting, camera angle and existing edits can affect scanning. Start
Compose afterward. The command refuses to overwrite an existing world. To
create a world at a different path, use
`python3 NetCraft/builder.py --init-park path/to/new.db`.

To add the park to a world that already exists, stop the server, back up its
database, and run `python3 NetCraft/builder.py --add-park data/netcraft.db`.
Existing block, light and sign edits are preserved; park blocks at those
positions are skipped, so existing edits may leave gaps or obstruct paths.
On an older park this adds the new islands and unoccupied dragon details
without repainting or removing the original sculpture. Restart the server
to load changes; do not run the builder while it runs.

#### Terrain modules

Use `--terrain` repeatedly to layer reusable JSON modules on top of
`--init-park` or `--add-park`. To apply only the modules to an existing world
without generating the park or compiling C, run:

```sh
python3 NetCraft/builder.py --apply-terrain data/netcraft.db \
  --terrain NetCraft/terrain/lookout.json
```

A module contains `"version": 1`, an optional `"origin": [x, y, z]` offset
(default `[0, 0, 0]`), and an `"edits"` array. Use `{"at": [x,y,z], "block": 8}`
for one block or `{"from": [x1,y1,z1], "to": [x2,y2,z2], "block": 8}` for an
inclusive box. Use numeric IDs from `src/item.h`; `0` places air over generated
terrain. Within a single command, later edits and files win at the same
coordinate. Existing saved blocks (including saved air), lights, and signs
always win, even when a module requests air. For an existing world, back it
up and stop the server before running the builder. Modules support coordinates
from `-262000` to `262000` on X/Z and `-26` to `255` on Y. A command accepts up
to 250,000 expanded module edits, and each file may be at most 8 MiB.

Compose enables mining rewards by default. Each ten naturally generated,
previously unedited blocks of green MINA, blue lapis, or red redstone ore mined
online earn one base unit of the corresponding configured token. Blue and red
occur in deep stone near bedrock, with red rarer than blue.
The leaderboard counts natural blocks by ore and sorts by total, including
blocks mined when a token category is not configured. It does not backfill from payouts.
Progress is saved per browser identity or registered address and token category;
unclaimed browser rewards are queued for payout when a wallet is connected. Earlier
paid rewards are unchanged. Green deposits appear on roughly one in 32 terrain columns; placed or
previously mined blocks do not earn another reward. Offline play and disconnected edits
cannot create rewards; payout requires a valid token-aware wallet address.
The interface calls the default reward MINA; the configured
CashToken category is unchanged by that display name. The game server requests
an immediate BCHN transaction for each ten eligible blocks; wallet transaction
creation is serialized to avoid spending the same inputs twice. The wallet
refreshes after the request and shows a receipt once it sees the zero-confirmation
output. A request can fail or take longer if the node or network is unavailable.
The wizard button reopens the dismissible game guide. The green gemstone opens
wallet connection or notifications; opening notifications marks them read.
Shared game links open a viewport-filling game; use the fullscreen button
for browser fullscreen, which requires a user gesture. Browsers may require a
user gesture before sound can play.
The HUD counts MINA ore blocks mined during the current game session, including
placed ore; it is not a token balance or a count of successful payouts. Chat
messages fade after a few seconds and remain visible while typing.
MINA ore pays the `BCH_REWARD_CATEGORY` category; fund the BCHN wallet with
that category and BCH for transaction fees. Set
`NETCRAFT_MINING_REWARDS_ENABLED=false` to stop new rewards and payouts. Back up the
world database and BCHN wallet together. Run only one payout worker. Set
`NETCRAFT_REWARD_WAKE_SECRET` to the same long random ASCII secret for both
services. Mining edits and payout records are committed together. Unsent
records are retried automatically.
Newly registered addresses have a one-unit welcome reward queued before mining
rewards for that address. Delivery depends on the funded payout wallet and node.
Welcome transaction records are in the cash-address database and mining
transaction records are in the world database, including signed transaction data,
transaction IDs and sent timestamps.
Investigate persistent errors. Signed transactions are stored before broadcast
and retried unchanged after an uncertain broadcast. The wallet can be drained by
transaction fees and output amounts, so fund and monitor it accordingly.
Each mining output carries the minimum standard BCH dust amount for the recipient
script (651 satoshis for P2PKH); zero-satoshi token outputs are not normally relayed.
The top ticker counts successfully broadcast one-unit payouts for the current
MINA category recorded in both reward databases, not all on-chain transfers.
The ranking counts broadcast mining payouts in the world database for the
current category. It records the player's in-game name when each payout is queued;
older rows without a name appear as "Unknown player". Names are not authenticated
and can be reused or changed, so the ranking is not proof of identity.
The ticker publicly displays the payout wallet's BCH balance.
Discontinued bonus records are left untouched and are not processed or counted.

BCHN RPC is bound to an isolated Compose network accessible only to the backend
and to localhost in the BCHN container. The backend's `check_balance()` reads
the payout wallet's BCH balance in satoshis; it is not an HTTP endpoint. An
operator can also run `bitcoin-cli` inside the BCHN container using the
configured wallet and RPC credentials. Protect the host, Docker access, `.env`,
and wallet backups: the backend can sign transactions, and its RPC credentials
grant wallet access. Keep only limited funds in the payout wallet.

The protocol does not authenticate players or prevent automated mining.
Mining payouts have no daily caps; a public server can spend all configured
tokens and BCH available for output values and fees. Standalone server and backend processes default to
rewards disabled unless `NETCRAFT_MINING_REWARDS_ENABLED=true`.
Deploy matching rebuilt Rust and WASM clients together when changing terrain
generation; existing edits remain, but unedited baseline terrain changes.
In multiplayer, the browser waits for each chunk's server snapshot before
displaying or editing it; movement pauses at chunks still loading.

### Browser wallet

The wallet dialog offers WizardConnect or a locally encrypted browser wallet.
Back up the English BIP39 recovery phrase offline before saving it. The
password encrypts this browser's storage; it is not a BIP39 passphrase, and
passphrases are not supported. Recovery uses BCH BIP44 paths
`m/44'/145'/0'/0/<index>` for receive and `m/44'/145'/0'/1/<index>` for
change on both mainnet and chipnet. Restore the phrase in a compatible wallet
using these paths if browser storage is lost. Copying a phrase exposes it to
the clipboard; clear the clipboard after use.

The browser wallet signs fungible CashToken sends locally and needs BCH for
transaction outputs and fees; NFT-bearing inputs are not used. Verify the
destination, category, amount and fee before approving. This implementation
has not had an independent security audit. An attacker controlling the site or
browser can steal an unlocked wallet, so use secure hosting and small amounts.
To reconnect after refresh, spend-capable account key material remains
unencrypted in session storage until disconnect or tab closure. Browser session
restore can retain it longer. Anyone with access to the tab, browser profile,
or malicious site scripts can spend its funds.

### Controls

On touch devices, drag from anywhere on the joystick to move in any direction;
the stick centers on the starting touch and returns when released. Drag the game view
to look, and use the on-screen buttons to jump, mine, build, and cycle blocks in
either direction. The larger mining button is at the lower right, next to the
build button. Press T or Enter and type a message, or use `/chat MESSAGE`.
Your message appears for seven seconds in a speech bubble above your avatar
for nearby players who can see you, and also appears in the chat console.
Use `/nick NAME` to set your in-game name. In the browser game, `/send NAME`
opens the wallet dashboard and shows the online player's token receive address
as a QR code. Connecting a wallet for mining makes its public receive address
available to players who look up your in-game name. Verify the address separately:
nicknames are not authenticated. Choose the category and amount and approve in
your wallet. The game's Send and Receive buttons provide the same actions.
Use `/receive` to select a configured MINA color and amount in the Receive tab,
then generate a QR and one-week short link back in the game. Select **Done**
to share both in a chat bubble with other online players. On desktop, press
Escape to release the mouse before clicking **Open payment request**. The link
opens the QR without leaving fullscreen and fills the Send tab for review.
Select **View payment request** to go to the wallet. This does not send a payment.
The BCHN ticker sits below the game controls in both windowed and fullscreen
mode and shows the tip hash, header lag,
difficulty, verification progress, median block time, chainwork, and storage stats.
New joins appear in chat. The Sound button
controls block and footstep sounds and the original looping tune after a user
gesture; the game panel also has a fullscreen button. The `?game=cashcraft` URL
parameter opens the panel below the top bar; browser fullscreen still
requires a user gesture.
The wizard button glows green while the tutorial runs. Tips advance automatically,
and the mining tip shows each ore's texture and live progress toward ten blocks.
On desktop, click the game view to capture the mouse; Escape releases it.
On a standard gamepad, the left stick and D-pad move, the right stick looks,
A jumps, B crouches, and the triggers build and mine.
If the browser or embedding page blocks gamepad access, keyboard, mouse and
touch controls remain available.
The invite button shares `/?game=cashcraft` and displays a donation QR for an
address generated by the payout wallet. Social previews use static gemstone and
block artwork without a QR. If the backend is unavailable, Caddy serves a static
fallback. BCHN must be
available to create the address on first use. Rebuild the frontend and backend
to update preview artwork. Social platforms may cache earlier previews;
Telegram's @WebpageBot can refresh a shared URL after deployment.
If a mining payout fails, inspect `docker compose logs auth netcraft bchn`:
the backend records safe diagnostic reasons and BCHN RPC error codes without
transaction details. Check node synchronization, payout wallet unlock and funding in both BCH
and the configured reward category before taking action.
Do not manually resend a signed pending transaction; it is retried unchanged.
Touch devices start with a three-chunk viewing radius and
desktop browsers with four to limit rendering cost;
use `/view <radius>` to adjust it. The right-hand block selector shows the
current block enlarged followed by the next available mined blocks and their
counts. Building consumes one matching block; blocks disappear from the selector
when their count reaches zero. Inventory resets when the connection is lost or the page reloads.
`/noclip` is
disabled by the online client; the server does not yet enforce movement
collision against modified clients. Closing the wallet or notifications
returns keyboard focus to the fullscreen game when appropriate.

Mouse:

- Left mouse button (hold) to destroy a block.
- Right Click or Ctrl + Left Click to create a block.
- Ctrl + Right Click to toggle a block as a light source.
- Middle Click to change the current block selection to the targeted block.
- Scrollwheel to cycle through the block types, or zoom in orthogonal mode.
- Drag-and-drop files onto the canvas to change [textures](#textures).

Keyboard:

- WASD to move forward, left, backward, right.
- Space to jump or swim upward; shift swims downward.
- Space double-tap to toggle between walking and flying (when flying, space to ascend, shift to descend).
- Shift to crouch, walk slower.
- Tab to sprint, while holding another directional key (increases movement speed).
- 1-9 to select the block type to create.
- E or R to cycle through the block types.
- Scroll the mouse wheel to cycle through blocks one slot at a time. On touch
  screens, drag up or down directly on the block HUD to change the selection.
- ZXCVBN to move in exact directions along the XYZ axes.
- Z to zoom.
- F to show the scene in orthographic mode.
- When in orthographic mode, use the scrollwheel or '+', '-' keys to zoom in and out.
- O to observe players in the main view.
- P to observe players in the picture-in-picture view.
- T or Enter to type text into chat (use up/down arrow keys to scroll through history).
- Forward slash (/) to enter a command.
- Backquote (`) to write text on any block (signs).
- Arrow keys emulate mouse movement.
- `[` emulates left mouse click.
- `]` emulates right mouse click.
- F11 to toggle fullscreen/windowed mode.
- F4 to toggle VR side-by-side stereo rendering.
- Shift-F4 to toggle barrel distortion effect.
- F2 to take a screenshot on the next scene render.
- F3 to toggle debug info text.
- F1 to toggle all user interface elements.

Joystick:

- A or D-pad up to jump.
- Left stick to move.
- Right stick to look.
- L1 and R1 bumpers to cycle through the block types.
- L2 trigger to destroy a block.
- R2 trigger to create a block.
- D-pad left/right to move left/right.
- D-pad down to crouch.

Touch:

- Swipe to free look.
- 2-finger touch to walk forward.
- 3-finger tap to jump.
- Tap and hold to destroy a block.
- Tap to create a block.

### Chat Commands

    /goto [NAME]

Teleport to another user.
If NAME is unspecified, a random user is chosen.

    /list

Display a list of connected users.

    /login NAME

Switch to another registered username.
The login server will be re-contacted. The username is case-sensitive.

    /logout

Unauthenticate and become a guest user.
Automatic logins will not occur again until the /login command is re-issued.

    /offline [FILE]

Switch to offline mode.
FILE specifies the save file to use and defaults to "craft".

    /online HOST [PORT]

Connect to the specified server.

    /pq P Q

Teleport to the specified chunk.

    /spawn

Teleport back to the spawn point. On the Rust server, players join and
respawn on the sky island plaza alongside the bots. If the plaza has no usable
landing spot, the server tries the dragon's back, then the normal ground spawn.

### Screenshot

![Screenshot](http://i.imgur.com/foYz3aN.png)

### Implementation Details

#### Terrain Generation

The terrain is generated using Simplex noise - a deterministic noise function seeded based on position. So the world will always be generated the same way in a given location.

The world is split up into 32x32 block chunks in the XZ plane (Y is up). This allows the world to be “infinite” (floating point precision is currently a problem at large X or Z values) and also makes it easier to manage the data. Only visible chunks need to be queried from the database.

#### Rendering

Only exposed faces are rendered. This is an important optimization as the vast majority of blocks are either completely hidden or are only exposing one or two faces. Each chunk records a one-block width overlap for each neighboring chunk so it knows which blocks along its perimeter are exposed.

Only visible chunks are rendered. A naive frustum-culling approach is used to test if a chunk is in the camera’s view. If it is not, it is not rendered. This results in a pretty decent performance improvement as well.

Chunk buffers are completely regenerated when a block is changed in that chunk, instead of trying to update the VBO.

Text is rendered using a bitmap atlas. Each character is rendered onto two triangles forming a 2D rectangle.

“Modern” OpenGL is used - no deprecated, fixed-function pipeline functions are used. Vertex buffer objects are used for position, normal and texture coordinates. Vertex and fragment shaders are used for rendering. Matrix manipulation functions are in matrix.c for translation, rotation, perspective, orthographic, etc. matrices. The 3D models are made up of very simple primitives - mostly cubes and rectangles. These models are generated in code in cube.c.

Transparency in glass blocks and plants (plants don’t take up the full rectangular shape of their triangle primitives) is implemented by discarding magenta-colored pixels in the fragment shader.

#### Textures

Textures are based on:

* [Craft](https://github.com/fogleman/Craft) by Michael Fogleman, MIT
* Pixeludi Pack by Wojtek Mroczek, Creative Commons CC-BY-SA, 2011, as used in [TrueCraft](https://github.com/SirCmpwn/TrueCraft/).
* [Piehole Plain](http://piehole.alexvoelk.de) by Alex Voelk, CC-BY-SA 3.0

The wallet's Mina theme uses enlarged grass and plank tiles derived from
`textures/texture.png`; the source texture credits and licenses above apply.
The game's grass, dirt, sand, stone, brick, oak, planks and cobblestone tiles
also include tiles from Craft's MIT-licensed
[`textures/texture.png`](https://github.com/fogleman/Craft/blob/d6888a6e1e54340358ce25b1220f410541360b6b/textures/texture.png)
by Michael Fogleman, remapped to this atlas. The remaining NetCraft tiles are
preserved.

Custom textures can be loaded from the server, or by dragging-and-dropping a .zip file or .png texture atlas
onto the game. NetCraft uses its own texture format, although there is some interoperability provided.
To customize textures you can start with [/textures/texture.png](/textures/texture.png), or (may not work
completely as expected), seek out an old texture pack for Minecraft 1.4.7 or earlier, such as
[Pixeludi](https://github.com/SirCmpwn/TrueCraft/blob/7f0e3338d231b8a8f7fba35742b618a4fb3575bf/TrueCraft.Client/Content/terrain.png),
[Piehole](http://piehole.alexvoelk.de), or
[Sphax PureBDcraft 16x](http://bdcraft.net/purebdcraft-minecraft#older).
Only texture atlas images are supported, in a manner somewhat compatible with [pre-1.5](http://minecraft.gamepedia.com/Texture_pack#Converting_texture_packs_to_resource_packs)
packs. High-resolution texture packs and packs for 1.5+ or newer, including resource packs, are not supported!


#### Database

User changes to the world are stored in a sqlite database. Only the delta is stored, so the default world is generated and then the user changes are applied on top when loading.

The main database table is named “block” and has columns p, q, x, y, z, w. (p, q) identifies the chunk, (x, y, z) identifies the block position and (w) identifies the block type. 0 represents an empty block (air).

In game, the chunks store their blocks in a hash map. An (x, y, z) key maps to a (w) value.

The y-position of blocks are limited to 0 <= y < 256. The upper limit is mainly an artificial limitation to prevent users from building unnecessarily tall structures. Users are not allowed to destroy blocks at y = 0 to avoid falling underneath the world.

#### Multiplayer

Multiplayer mode is implemented using plain-old sockets. A simple, ASCII, line-based protocol is used. Each line is made up of a command code and zero or more comma-separated arguments. The client requests chunks from the server with a simple command: C,p,q,key. “C” means “Chunk” and (p, q) identifies the chunk. The key is used for caching - the server will only send block updates that have been performed since the client last asked for that chunk. Block updates (in realtime or as part of a chunk request) are sent to the client in the format: B,p,q,x,y,z,w. After sending all of the blocks for a requested chunk, the server will send an updated cache key in the format: K,p,q,key. The client will store this key and use it the next time it needs to ask for that chunk. Player positions are sent in the format: P,pid,x,y,z,rx,ry. The pid is the player ID and the rx and ry values indicate the player’s rotation in two different axes. The client interpolates player positions from the past two position updates for smoother animation. The client sends its position to the server at most every 0.1 seconds (less if not moving).

Client-side caching to the sqlite database can be performance intensive when connecting to a server for the first time. For this reason, sqlite writes are performed on a background thread. All writes occur in a transaction for performance. The transaction is committed every 5 seconds as opposed to some logical amount of work completed. A ring / circular buffer is used as a queue for what data is to be written to the database.

In multiplayer mode, players can observe one another in the main view or in a picture-in-picture view. Implementation of the PnP was surprisingly simple - just change the viewport and render the scene again from the other player’s point of view.

#### Collision Testing

Hit testing (what block the user is pointing at) is implemented by scanning a ray from the player’s position outward, following their sight vector. This is not a precise method, so the step rate can be made smaller to be more accurate.

Collision testing simply adjusts the player’s position to remain a certain distance away from any adjacent blocks that are obstacles. (Clouds and plants are not marked as obstacles, so you pass right through them.)

#### Sky Dome

A textured sky dome is used for the sky. The X-coordinate of the texture represents time of day. The Y-values map from the bottom of the sky sphere to the top of the sky sphere. The player is always in the center of the sphere. The fragment shaders for the blocks also sample the sky texture to determine the appropriate fog color to blend with based on the block’s position relative to the backing sky.

#### Ambient Occlusion

Ambient occlusion is implemented as described on this page:

http://0fps.wordpress.com/2013/07/03/ambient-occlusion-for-minecraft-like-worlds/

#### Dependencies

* GLEW is used for managing OpenGL extensions across platforms.
* GLFW is used for cross-platform window management.
* CURL is used for HTTPS / SSL POST for the authentication process.
* lodepng is used for loading PNG textures.
* miniz is used for writing PNG screenshots and loading zip archives.
* sqlite3 is used for saving the blocks added / removed by the user.
* tinycthread is used for cross-platform threading.
* emscripten is used for compiling to the web platform.
