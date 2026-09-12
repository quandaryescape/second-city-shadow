# Second City Shadow — Field Ops Terminal

A pack-and-play mobile escape-room webapp. Hosts on a Raspberry Pi (or any
Node server), serves the player UI to phones over the local network, and
fires HTTP webhooks to ESP32s when puzzles are solved.

## What it does

- Multiple players join a single session by visiting the URL on their phones.
- Six modules: **Analyze**, **Hack**, **Features**, **Blueprint**, **Signal**, **Phone**.
- Analyze, Hack, and Signal are multiplayer mini-games synced through Socket.IO.
- Features and Blueprint are solo 3D viewers built on Three.js.
- Phone is a keypad that plays a video when a known number is dialed.
- All puzzle solutions, codes, audio paths, video paths, and ESP32 webhook URLs
  live in [`config/puzzles.json`](config/puzzles.json) — no code changes needed.

## Run

```bash
cd app
npm install
npm start
```

Then open:

- Host:    `http://<pi-ip>:3000/admin.html`  → create a room, get a code (e.g. `7K2P`)
- Players: `http://<pi-ip>:3000/`            → enter room code + callsign
- Or share a join link with the code prefilled: `http://<pi-ip>:3000/?room=7K2P`

Default port `3000`. Override with `PORT=8080 npm start`.

## Rooms

The server supports **multiple concurrent rooms**, so several physical
escape-room kits can run on one Pi at the same time.

- The host creates a room from the admin console. They get a 4-character
  code (uppercase letters + digits, no confusable chars like `0/O/1/I/L`).
- Players type that code on their phone to join. Each room is fully
  isolated — separate rosters, locks, puzzles, logs.
- Each room can override the global ESP32 webhook URLs at creation time
  (or later via the room's "Webhook Overrides" panel). Useful when
  different physical kits each have their own ESP32s.
- The webhook payload is augmented with the room code so a single shared
  ESP32 can also tell which room fired.

## Setup Console (edit everything visually)

Open `http://<pi-ip>:3000/setup.html` (also linked from the host console).
It edits `config/puzzles.json` through the browser — no file editing needed —
and applies changes to live rooms on save. Each save writes a timestamped
backup to `config/backups/` (last 25 kept).

- **3D POINTS** — the fix for hard-to-place scan markers: the bomb model is
  shown in 3D; tap **ADD POINT** and click the surface to drop a marker
  exactly where you want it. Points get saved as raw model coordinates, so
  they land in the identical spot in the player's Features viewer. Existing
  section/direction-based points still work and can be repositioned (MOVE),
  which converts them to fixed points.
- **QUADRANTS** — click any of the 8 blueprint sections in the exploded view
  and rename its number/code/name, change its model file or explode offset,
  and tune the explode factor with a live slider.
- **Which way is the front** — both 3D tabs have a FRONT/BACK/LEFT/RIGHT/TOP
  view bar and a **USE THIS VIEW AS FRONT** button: orbit until the prop's
  real front faces you, press it, and that becomes the FRONT view players
  get. See [Features](#features).
- **ANALYZE / HACK / SIGNAL / PHONE** — all answers, sequences, timings,
  instructions, and success messages. Signal has a tap-to-build answer-order
  builder; Signal and Phone have media pickers with in-browser **upload**
  (drop new fragment audio / villain videos right from the page).
- **SESSION & DEVICES** — player counts, auto-unlocks, ESP32 webhook URLs
  and payloads.
- **THEME** — title, labels, and the two accent colors (restyle the whole
  player app).
- **RAW JSON** — direct config editing for anything else.

Note: like the host console, the setup page has no login — anyone on the
LAN who knows the URL can open it. Fine for a private kit network; don't
expose the port to the internet.

## Edit puzzles by hand

`config/puzzles.json` is still the source of truth and can be edited
directly. After editing, either:
- Click **Reload Config** in the host console, or
- POST to `/api/reload-config`, or
- Restart the server.

Key fields:

| Path | What it does |
|---|---|
| `session.minPlayers` / `maxPlayers` | Player count bounds. |
| `session.playerCodeLength` | Length (digits) of each player's join code. |
| `session.autoUnlockOnAnalyzeSuccess` | Modules unlocked once analyze completes. |
| `esp32.hackWebhook` / `signalWebhook` | URLs the server `POST`s to on success. |
| `esp32.hackPayload` / `signalPayload` | JSON body sent. |
| `analyze.shapes` | Pool of shape names used in the chain (8 supported). |
| `hack.sequenceLength` | Number of taps required to complete the hack. |
| `hack.stepTimeoutMs` | Per-step timeout (ms). |
| `hack.failRetryDelayMs` | Pause before the server auto-restarts a failed sequence. |
| — | If too few agents are online at that moment the hack **pauses** ("PAUSED · NEED MORE PLAYERS") and resumes by itself when they reconnect; it never dumps players back to the hub. A dropped agent's pending turns are handed to players who are still online. |
| `hack.successExitDelayMs` | How long the success screen shows before returning to the hub. |
| `signal.fragments` | Audio fragments (id, symbol, label, audio path). Players see the symbol (e.g. Greek letters) on the order pad. |
| `signal.correctOrder` | Solution order by fragment id, e.g. `[3,1,4,2]`. |
| `hack.successMessage` / `signal.successMessage` | Message shown when solved. |
| `hack.successMedia` / `signal.successMedia` | Optional video (full-screen) or audio played when solved. |
| `hack.fireWebhook` / `signal.fireWebhook` | Whether solving fires the ESP32 webhook (default true). |
| `hack.lightPattern` | 3×2 grid of `0`/`1` sent to the ESP32 on success — see [Hack light pattern](#hack-light-pattern). |
| `phone.callMap` | `[{ number, kind, src, label }]` — dialed number → video. |
| `features.lockPickPoints` | Red markers on the bomb (label, position, section). |
| `features.frontYawDeg` / `blueprint.frontYawDeg` | Rotation (degrees) that turns the raw scan so the prop's real front faces the camera's FRONT view. Set it visually in the Setup Console. |
| `features.autoRotate` / `blueprint.autoRotate` | Whether the view idles with a slow orbit (players can stop it with SPIN). |
| `blueprint.sections` | The 8 sections (id, code, name, model, offset). |
| `blueprint.explodeFactor` | How far apart the sections fly in the exploded view. |

## ESP32 integration

When the Hack mini-game succeeds, the server sends:

```http
POST http://<your-esp32>/trigger/hack
Content-Type: application/json

{
  "event": "hack_complete",
  "room": "7K2P",
  "pattern": [[1,0,1], [0,1,0]],
  "lights": [1,0,1,0,1,0],
  "bits": "101010",
  "mask": 21,
  "rows": 2,
  "cols": 3
}
```

Signal sends the same shape minus the light fields. URLs, method, headers, and
the base payload are all in `esp32.*` in `puzzles.json`. Most ESP32 sketches
with `WebServer.h` need only a route handler listening for the POST. The host
console has manual **FIRE** buttons to test each webhook without playing.

### Hack light pattern

Draw the 3×2 light grid in the Setup Console (**HACK → ESP32 LIGHT PATTERN**)
and it rides along in the hack webhook, so the ESP32 knows what to show. The
same pattern is sent four ways — use whichever is easiest in your sketch:

| Field | Value | Use it when |
|---|---|---|
| `pattern` | `[[1,0,1],[0,1,0]]` | You want rows exactly as drawn. |
| `lights` | `[1,0,1,0,1,0]` | You loop over 6 pins in order. |
| `bits` | `"101010"` | Easiest to parse without a JSON library. |
| `mask` | `21` | One integer; bit *i* = light *i*. |

Light order is row-major — top-left is light 1 (`lights[0]`, `mask` bit 0),
top-right is light 3, bottom-right is light 6. The console labels each cell
`L1`–`L6` to match, and shows a live preview of the exact body it will send.

Simplest sketch shape, using `mask`:

```cpp
const int PINS[6] = {12, 13, 14, 27, 26, 25};  // L1..L6

void applyMask(uint8_t mask) {
  for (int i = 0; i < 6; i++) {
    digitalWrite(PINS[i], (mask >> i) & 1 ? HIGH : LOW);
  }
}
```

Note the pattern is global (it comes from `puzzles.json`), not per-room, so
every kit sharing this server shows the same pattern. Per-kit *webhook URLs*
are still overridable per room in the host console.

## Assets

Drop your media here:

- `public/audio/signal/frag1.mp3` … `frag8.mp3` — the signal fragments.
- `public/video/villain.mp4` — the FaceTime-style villain video.

The 3D models are already in place under `3dfiles/` and served at `/3dfiles/*`.

## How the games work

### Analyze
Each player gets `[shapeIn] – YOU – [shapeOut]` plus their own 3-digit code.
Each player's `shapeOut` matches exactly one other player's `shapeIn` —
the assignment forms a closed ring of N players. Each player must enter the
code of the player whose `shapeIn` matches their own `shapeOut`. When all
players submit correctly, the four secondary modules unlock.

### Hack
Server randomly picks a sequence of player IDs (length = `hack.sequenceLength`).
The player whose ID is current sees a glowing **TAP** button; everyone else
sees **WAIT**. A wrong tap or a missed step (`hack.stepTimeoutMs`) fails the
sequence and resets. On success, the Hack webhook fires.

### Signal
Each player gets one audio fragment. They play their fragment, listen to
each other, decide the order, then any one player taps the numbers in order
on the order pad and submits. Correct order → Signal webhook fires.

### Features
Three.js wireframe of `bomb_full.obj` with red glowing markers at every
`lockPickPoints` entry. Orbit controls (drag to rotate, pinch to zoom).

Both 3D screens have a **FRONT / BACK / LEFT / RIGHT / TOP** button row plus
**SPIN**, and a live readout in the top-right corner naming the side currently
in view (e.g. `VIEW · FRONT-LEFT`). The model itself never turns — it holds a
fixed orientation and the camera moves — so "front" always means the same face
and players can line the render up with the physical prop.

**Set which side is the front:** the raw scan's orientation is arbitrary, so in
the Setup Console (**3D POINTS** and **QUADRANTS** tabs) orbit until the prop's
real front faces you and press **USE THIS VIEW AS FRONT**. That bakes a
`frontYawDeg` into the config, which the player viewers apply on load. It also
fixes which side section-based markers (`"section": "FTR"`) land on, and makes
the blueprint's FTL/FBR naming line up with the real object. The same row has a
numeric yaw field for exact angles and a **SPIN BY DEFAULT** toggle.

### Blueprint
Loads all 8 section OBJs and animates them outward into an exploded
diagram, each labeled 1–8.

### Phone
Standard 12-key dialpad. Long-press `0` for `+`. The configured directory is
clickable to auto-fill. Calling a number that matches `phone.callMap` plays
the corresponding video full-screen.

## Project layout

```
app/
├── server.js                 Express + Socket.IO + config/media APIs
├── package.json
├── config/puzzles.json       All customizable solutions
├── config/backups/           Auto-backups written on each setup-console save
├── 3dfiles/                  Bomb OBJ files (served at /3dfiles)
└── public/
    ├── index.html            Player app
    ├── admin.html            Host console
    ├── setup.html            Setup console (content & puzzle editor)
    ├── css/style.css         Theme
    ├── js/app.js             Bootstrap, screens, socket
    ├── js/games/             analyze.js, hack.js, signal.js, phone.js
    ├── js/viewer/            features.js, blueprint.js
    ├── js/setup/             setup.js, points-editor.js, quadrants-editor.js
    ├── audio/signal/         fragN.mp3
    └── video/                villain.mp4
```

## Notes

- No build step; pure ES modules + import map for Three.js. Works on any
  modern phone browser.
- Player session is stored in `sessionStorage` so a refresh rejoins.
- All UI text and the "Second City Shadow" branding is configurable in
  `puzzles.json` under `ui.*`.
- No Batman logos or trademarked iconography are used — original glyphs only.
