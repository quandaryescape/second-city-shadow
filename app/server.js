import express from "express";
import http from "http";
import { Server as IOServer } from "socket.io";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, "config", "puzzles.json");

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}
let cfg = loadConfig();

// ---------- rooms ----------
const rooms = new Map(); // code -> RoomState

function newRoomState(code, opts = {}) {
  return {
    code,
    createdAt: Date.now(),
    phase: "lobby",
    players: [],
    unlocked: { hack: false, features: false, blueprint: false, signal: false },
    analyze: null,
    hack: null,
    signal: null,
    hackTimer: null,
    signalTimer: null,
    log: [],
    overrides: {
      hackWebhook: opts.hackWebhook || null,
      signalWebhook: opts.signalWebhook || null,
    },
  };
}

// Avoid easily-confused chars (0/O, 1/I/L). 4-char codes are plenty.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function newRoomCode() {
  for (let i = 0; i < 100; i++) {
    let c = "";
    for (let j = 0; j < 4; j++) {
      c += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    }
    if (!rooms.has(c)) return c;
  }
  return "R" + Date.now().toString(36).slice(-3).toUpperCase();
}

function pushLog(room, msg) {
  room.log.unshift({ t: Date.now(), msg });
  room.log = room.log.slice(0, 200);
}

function publicState(room) {
  if (!room) return null;
  return {
    code: room.code,
    phase: room.phase,
    unlocked: room.unlocked,
    players: room.players.map((p) => ({ id: p.id, name: p.name, connected: p.connected })),
    analyze: room.analyze && {
      complete: room.analyze.complete,
      submittedCount: Object.keys(room.analyze.submissions).length,
      total: room.players.length,
    },
    hack: room.hack && {
      step: room.hack.step,
      length: room.hack.sequence?.length ?? 0,
      status: room.hack.status,
      currentPlayerId: room.hack.sequence?.[room.hack.step] ?? null,
      waiting: room.hack.waiting || null,
    },
    signal: room.signal && {
      complete: room.signal.complete,
      submittedBy: room.signal.submittedBy ?? null,
      lastWrong: room.signal.lastWrong ?? null,
    },
    ui: cfg.ui,
  };
}

function broadcast(room) {
  io.to(room.code).emit("state", publicState(room));
}

function broadcastRoomList() {
  io.to("admin").emit("rooms", listRooms());
}

function listRooms() {
  return [...rooms.values()].map((r) => ({
    code: r.code,
    phase: r.phase,
    players: r.players.length,
    online: r.players.filter((p) => p.connected).length,
    createdAt: r.createdAt,
    overrides: { ...r.overrides },
    unlocked: { ...r.unlocked },
  }));
}

function newId() { return Math.random().toString(36).slice(2, 8); }
function newPlayerCode(existing) {
  const len = cfg.session.playerCodeLength || 3;
  const max = 10 ** len;
  for (let i = 0; i < 200; i++) {
    const c = String(Math.floor(Math.random() * max)).padStart(len, "0");
    if (!existing.includes(c)) return c;
  }
  return String(Date.now()).slice(-len);
}
function shuffle(a) {
  const arr = a.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function roomOf(socket) {
  const code = socket.data.roomCode;
  return code ? rooms.get(code) : null;
}
function findPlayer(socket) {
  const room = roomOf(socket);
  if (!room) return null;
  return room.players.find((p) => p.socketId === socket.id);
}

// ---------- player ----------
function addPlayer(room, name, socketId) {
  if (room.players.length >= cfg.session.maxPlayers) return { error: "Session full" };
  const codes = room.players.map((p) => p.code);
  const player = {
    id: newId(),
    name: name?.trim()?.slice(0, 24) || `AGENT-${room.players.length + 1}`,
    socketId,
    code: newPlayerCode(codes),
    connected: true,
  };
  room.players.push(player);
  pushLog(room, `${player.name} joined as ${player.code}`);
  return { player };
}

// ---------- analyze ----------
function startAnalyze(room) {
  if (room.players.length < cfg.session.minPlayers) {
    return { error: `Need at least ${cfg.session.minPlayers} players` };
  }
  const shapesPool = cfg.analyze.shuffleShapes ? shuffle(cfg.analyze.shapes) : cfg.analyze.shapes.slice();
  const players = shuffle(room.players.slice());
  const n = players.length;
  if (shapesPool.length < n) return { error: "Not enough shapes configured" };
  const ringShapes = shapesPool.slice(0, n);
  const chain = [];
  for (let i = 0; i < n; i++) {
    chain.push({
      playerId: players[i].id,
      shapeIn: ringShapes[i],
      shapeOut: ringShapes[(i + 1) % n],
      nextPlayerId: players[(i + 1) % n].id,
    });
  }
  room.analyze = { chain, submissions: {}, complete: false };
  room.phase = "analyze";
  pushLog(room, `Analyze started (${n} players)`);
  return { ok: true };
}

function submitAnalyze(room, playerId, targetCode) {
  if (!room.analyze) return { error: "Not in analyze" };
  const link = room.analyze.chain.find((c) => c.playerId === playerId);
  if (!link) return { error: "Not in chain" };
  const target = room.players.find((p) => p.id === link.nextPlayerId);
  if (!target) return { error: "No target" };
  const ok = String(targetCode).trim() === target.code;
  if (ok) {
    room.analyze.submissions[playerId] = link.nextPlayerId;
    if (Object.keys(room.analyze.submissions).length === room.analyze.chain.length) {
      room.analyze.complete = true;
      room.phase = "main";
      for (const k of cfg.session.autoUnlockOnAnalyzeSuccess) {
        if (k in room.unlocked) room.unlocked[k] = true;
      }
      pushLog(room, "Analyze COMPLETE — features unlocked");
    }
  }
  return { ok };
}

// ---------- hack ----------
// The server owns ALL hack timing through the single room.hackTimer:
// countdown -> step timeout -> auto-retry after fail -> auto-exit after
// success. Clients only display state and send taps; letting every client
// schedule retries/exits caused stale timers to restart or abort the game
// mid-round.
function setHackTimer(room, fn, ms) {
  clearTimeout(room.hackTimer);
  room.hackTimer = fn == null ? null : setTimeout(() => {
    if (rooms.get(room.code) !== room) return; // room was closed
    fn();
  }, ms);
}

function startHack(room) {
  if (!room.unlocked.hack) return { error: "Hack locked" };
  if (room.hack && (room.hack.status === "countdown" || room.hack.status === "running")) {
    return { error: "Hack already running" };
  }
  const eligible = room.players.filter((p) => p.connected);
  if (eligible.length < cfg.session.minPlayers) return { error: "Need more players" };
  const len = cfg.hack.sequenceLength;
  const seq = [];
  for (let i = 0; i < len; i++) {
    seq.push(eligible[Math.floor(Math.random() * eligible.length)].id);
  }
  room.hack = { sequence: seq, step: 0, status: "countdown", startsAt: Date.now() + cfg.hack.preStartCountdownMs };
  room.phase = "hack";
  pushLog(room, `Hack started (${len} steps)`);
  setHackTimer(room, () => {
    if (room.hack?.status === "countdown") {
      room.hack.status = "running";
      armHackStepTimer(room);
      broadcast(room);
    }
  }, cfg.hack.preStartCountdownMs);
  return { ok: true };
}

function armHackStepTimer(room) {
  if (!room.hack || room.hack.status !== "running") return;
  setHackTimer(room, () => {
    if (room.hack?.status === "running") {
      failHack(room, "timeout");
      broadcast(room);
    }
  }, cfg.hack.stepTimeoutMs);
}

function failHack(room, reason) {
  room.hack.status = "fail";
  pushLog(room, `Hack failed (${reason})`);
  scheduleHackRestart(room);
}

// Retry forever while the room is in the hack phase. A failed restart (a
// phone dropped, so too few agents are online) must NEVER exit to the hub —
// doing that yanked every player to the main screen over one wifi blip.
function scheduleHackRestart(room) {
  setHackTimer(room, () => {
    if (room.phase !== "hack" || room.hack?.status !== "fail") return;
    const r = startHack(room);
    if (r.error) {
      room.hack.waiting = r.error;
      scheduleHackRestart(room);
    }
    broadcast(room);
  }, cfg.hack.failRetryDelayMs ?? 1600);
}

// A player dropping mid-run used to deadlock the sequence: their steps could
// never be tapped, so every round timed out. Hand their remaining steps to
// agents who are still online so the game just carries on.
function reassignHackSteps(room, goneId) {
  const h = room.hack;
  if (!h || (h.status !== "running" && h.status !== "countdown")) return;
  const online = room.players.filter((p) => p.connected);
  if (!online.length) return;
  let moved = 0;
  for (let i = h.step; i < h.sequence.length; i++) {
    if (h.sequence[i] === goneId) {
      h.sequence[i] = online[Math.floor(Math.random() * online.length)].id;
      moved++;
    }
  }
  if (moved) {
    pushLog(room, `Reassigned ${moved} hack step(s) from a dropped agent`);
    if (h.status === "running") armHackStepTimer(room); // fresh window for the new agent
  }
}

function hackTap(room, playerId) {
  if (!room.hack || room.hack.status !== "running") return { error: "not running" };
  const expected = room.hack.sequence[room.hack.step];
  if (expected !== playerId) {
    failHack(room, "wrong player");
    return { ok: false, fail: true };
  }
  room.hack.step++;
  if (room.hack.step >= room.hack.sequence.length) {
    room.hack.status = "success";
    if (cfg.hack.fireWebhook !== false) {
      pushLog(room, "Hack SUCCESS — firing ESP32");
      fireWebhook(room, "hack");
    } else {
      pushLog(room, "Hack SUCCESS (webhook disabled)");
    }
    setHackTimer(room, () => {
      if (room.hack?.status === "success") {
        exitHack(room);
        broadcast(room);
      }
    }, cfg.hack.successExitDelayMs ?? 2500);
    return { ok: true, success: true };
  }
  armHackStepTimer(room);
  return { ok: true };
}

function exitHack(room) {
  room.hack = null;
  room.phase = "main";
  setHackTimer(room, null);
}

// ---------- signal ----------
function startSignal(room) {
  if (!room.unlocked.signal) return { error: "Signal locked" };
  const order = cfg.signal.correctOrder;
  if (!order || !order.length) return { error: "Signal not configured" };
  const players = room.players.slice();
  const assignments = {};
  const pool = shuffle(order.slice());
  for (let i = 0; i < players.length; i++) {
    assignments[players[i].id] = pool[i % pool.length];
  }
  room.signal = { assignments, complete: false, submittedBy: null, lastWrong: null };
  room.phase = "signal";
  pushLog(room, "Signal started");
  return { ok: true };
}

function submitSignal(room, playerId, order) {
  if (!room.signal || room.signal.complete) return { error: "not running" };
  const correct = cfg.signal.correctOrder;
  const ok = Array.isArray(order)
    && order.length === correct.length
    && order.every((v, i) => Number(v) === Number(correct[i]));
  room.signal.submittedBy = playerId;
  if (ok) {
    // Stay in the signal phase so every client shows the success outcome
    // (message/media); the server exits to main after a single delay.
    room.signal.complete = true;
    if (cfg.signal.fireWebhook !== false) {
      pushLog(room, "Signal SUCCESS — firing ESP32");
      fireWebhook(room, "signal");
    } else {
      pushLog(room, "Signal SUCCESS (webhook disabled)");
    }
    clearTimeout(room.signalTimer);
    room.signalTimer = setTimeout(() => {
      if (rooms.get(room.code) !== room) return;
      if (room.signal?.complete) {
        exitSignal(room);
        broadcast(room);
      }
    }, cfg.signal.successExitDelayMs ?? 3000);
  } else {
    room.signal.lastWrong = Date.now();
  }
  return { ok };
}

function exitSignal(room) {
  room.signal = null;
  room.phase = "main";
  clearTimeout(room.signalTimer);
}

// ---------- webhook ----------
// Turn the authored light grid into every shape an ESP32 sketch might want:
//   pattern  [[1,0,1],[0,1,0]]  rows of the grid, as drawn in the setup console
//   lights   [1,0,1,0,1,0]      flat, row-major (top-left first)
//   bits     "101010"           same order, as a string
//   mask     21                 same order, bit i = light i (LSB = light 1)
function lightPatternPayload(grid) {
  if (!Array.isArray(grid) || !grid.length || !Array.isArray(grid[0])) return null;
  const pattern = grid.map((row) => row.map((v) => (v ? 1 : 0)));
  const lights = pattern.flat();
  let mask = 0;
  lights.forEach((v, i) => { if (v) mask |= 1 << i; });
  return {
    pattern,
    lights,
    bits: lights.join(""),
    mask,
    rows: pattern.length,
    cols: pattern[0].length,
  };
}

async function fireWebhook(room, kind) {
  const overrideKey = kind === "hack" ? "hackWebhook" : "signalWebhook";
  const url = room.overrides[overrideKey]
    || (kind === "hack" ? cfg.esp32.hackWebhook : cfg.esp32.signalWebhook);
  const basePayload = kind === "hack" ? cfg.esp32.hackPayload : cfg.esp32.signalPayload;
  const body = { ...(basePayload || {}), room: room.code };
  if (kind === "hack") {
    const lp = lightPatternPayload(cfg.hack.lightPattern);
    if (lp) Object.assign(body, lp);
  }
  if (!url) {
    pushLog(room, `No webhook configured for ${kind}`);
    return;
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), cfg.esp32.webhookTimeoutMs ?? 4000);
  try {
    const res = await fetch(url, {
      method: cfg.esp32.webhookMethod || "POST",
      headers: cfg.esp32.headers || { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    pushLog(room, `Webhook ${kind} -> ${res.status}`);
  } catch (e) {
    pushLog(room, `Webhook ${kind} FAILED: ${e.message}`);
  } finally {
    clearTimeout(t);
  }
}

// ---------- admin ops ----------
function adminReset(room) {
  room.phase = "lobby";
  room.unlocked = { hack: false, features: false, blueprint: false, signal: false };
  room.analyze = null;
  room.hack = null;
  room.signal = null;
  clearTimeout(room.hackTimer);
  clearTimeout(room.signalTimer);
  pushLog(room, "ADMIN: full reset");
}
function adminUnlockAll(room) {
  room.unlocked = { hack: true, features: true, blueprint: true, signal: true };
  pushLog(room, "ADMIN: unlocked all");
}
function adminKick(room, playerId) {
  const idx = room.players.findIndex((p) => p.id === playerId);
  if (idx >= 0) {
    const [p] = room.players.splice(idx, 1);
    if (p.socketId) io.to(p.socketId).emit("kicked");
    pushLog(room, `ADMIN: kicked ${p.name}`);
  }
}
function adminCloseRoom(code) {
  const room = rooms.get(code);
  if (!room) return;
  io.to(code).emit("kicked");
  clearTimeout(room.hackTimer);
  clearTimeout(room.signalTimer);
  rooms.delete(code);
}

// ---------- HTTP / Sockets ----------
const app = express();
app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/3dfiles", express.static(path.join(__dirname, "3dfiles")));

app.get("/api/config", (_req, res) =>
  res.json({
    ui: cfg.ui,
    analyze: { instructions: cfg.analyze.instructions, successMessage: cfg.analyze.successMessage },
    hack: {
      instructions: cfg.hack.instructions,
      successMessage: cfg.hack.successMessage,
      successMedia: cfg.hack.successMedia || "",
      stepTimeoutMs: cfg.hack.stepTimeoutMs,
      preStartCountdownMs: cfg.hack.preStartCountdownMs,
    },
    signal: {
      instructions: cfg.signal.instructions,
      successMessage: cfg.signal.successMessage,
      successMedia: cfg.signal.successMedia || cfg.signal.successAudio || "",
      fragments: cfg.signal.fragments,
      length: cfg.signal.correctOrder.length,
    },
    phone: {
      title: cfg.phone.title,
      contacts: cfg.phone.contacts,
      fallbackMessage: cfg.phone.fallbackMessage,
      callMap: cfg.phone.callMap,
    },
    features: cfg.features,
    blueprint: cfg.blueprint,
    session: cfg.session,
  })
);

app.post("/api/reload-config", (_req, res) => {
  try {
    cfg = loadConfig();
    for (const room of rooms.values()) pushLog(room, "Config reloaded from disk");
    for (const room of rooms.values()) broadcast(room);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/rooms", (_req, res) => res.json({ rooms: listRooms() }));

// ---------- setup console: config editing ----------
const REQUIRED_TOP_KEYS = ["session", "esp32", "analyze", "hack", "signal", "phone", "features", "blueprint", "ui"];
const BACKUP_DIR = path.join(__dirname, "config", "backups");

function validateConfig(c) {
  if (!c || typeof c !== "object" || Array.isArray(c)) return "Config must be a JSON object";
  for (const k of REQUIRED_TOP_KEYS) {
    if (!(k in c)) return `Missing top-level section: "${k}"`;
  }
  if (!Array.isArray(c.signal.fragments)) return "signal.fragments must be an array";
  if (!Array.isArray(c.signal.correctOrder) || !c.signal.correctOrder.length) return "signal.correctOrder must be a non-empty array";
  const fragIds = new Set(c.signal.fragments.map((f) => Number(f.id)));
  for (const id of c.signal.correctOrder) {
    if (!fragIds.has(Number(id))) return `signal.correctOrder references unknown fragment id ${id}`;
  }
  if (!Array.isArray(c.blueprint.sections) || !c.blueprint.sections.length) return "blueprint.sections must be a non-empty array";
  if (!Array.isArray(c.analyze.shapes) || c.analyze.shapes.length < (c.session.maxPlayers || 1)) {
    return `analyze.shapes must contain at least maxPlayers (${c.session.maxPlayers}) entries`;
  }
  if (!Array.isArray(c.phone.callMap)) return "phone.callMap must be an array";
  if (c.hack.lightPattern !== undefined) {
    const g = c.hack.lightPattern;
    if (!Array.isArray(g) || !g.length || !g.every(Array.isArray)) {
      return "hack.lightPattern must be an array of rows";
    }
    if (!g.every((row) => row.length === g[0].length)) return "hack.lightPattern rows must all be the same length";
    if (!g.every((row) => row.every((v) => v === 0 || v === 1))) return "hack.lightPattern cells must be 0 or 1";
  }
  if (!(c.session.minPlayers >= 1)) return "session.minPlayers must be >= 1";
  if (!(c.session.maxPlayers >= c.session.minPlayers)) return "session.maxPlayers must be >= minPlayers";
  return null;
}

function backupConfig() {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    fs.copyFileSync(CONFIG_PATH, path.join(BACKUP_DIR, `puzzles-${stamp}.json`));
    // keep the newest 25 backups
    const files = fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith(".json")).sort();
    for (const f of files.slice(0, Math.max(0, files.length - 25))) {
      fs.unlinkSync(path.join(BACKUP_DIR, f));
    }
  } catch (e) {
    console.warn("Config backup failed:", e.message);
  }
}

app.get("/api/admin/config", (_req, res) => {
  try { res.json(loadConfig()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.put("/api/admin/config", (req, res) => {
  const err = validateConfig(req.body);
  if (err) return res.status(400).json({ error: err });
  try {
    backupConfig();
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(req.body, null, 2) + "\n", "utf8");
    cfg = loadConfig();
    for (const room of rooms.values()) {
      pushLog(room, "Config updated from setup console");
      broadcast(room);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- setup console: media library ----------
const MEDIA_DIRS = {
  "video": path.join(__dirname, "public", "video"),
  "audio": path.join(__dirname, "public", "audio"),
  "audio/signal": path.join(__dirname, "public", "audio", "signal"),
};
const MEDIA_EXT = new Set([".mp4", ".webm", ".mov", ".m4v", ".mp3", ".wav", ".ogg", ".m4a", ".aac", ".flac"]);

function safeMediaName(name) {
  const base = path.basename(String(name || "")).replace(/[^A-Za-z0-9._ -]/g, "_").trim();
  if (!base || base.startsWith(".")) return null;
  if (!MEDIA_EXT.has(path.extname(base).toLowerCase())) return null;
  return base;
}

app.get("/api/media", (req, res) => {
  const dir = String(req.query.dir || "");
  const root = MEDIA_DIRS[dir];
  if (!root) return res.status(400).json({ error: "dir must be one of: " + Object.keys(MEDIA_DIRS).join(", ") });
  let files = [];
  try {
    fs.mkdirSync(root, { recursive: true });
    files = fs.readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isFile() && MEDIA_EXT.has(path.extname(d.name).toLowerCase()))
      .map((d) => {
        const st = fs.statSync(path.join(root, d.name));
        return { name: d.name, path: `/${dir}/${d.name}`, size: st.size, mtime: st.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
  res.json({ files });
});

app.post(
  "/api/media/upload",
  express.raw({ type: () => true, limit: "1gb" }),
  (req, res) => {
    const dir = String(req.query.dir || "");
    const root = MEDIA_DIRS[dir];
    if (!root) return res.status(400).json({ error: "Bad dir" });
    const name = safeMediaName(req.query.name);
    if (!name) return res.status(400).json({ error: "Bad filename (allowed: mp4/webm/mov/m4v/mp3/wav/ogg/m4a/aac/flac)" });
    if (!req.body || !req.body.length) return res.status(400).json({ error: "Empty upload" });
    try {
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(path.join(root, name), req.body);
      res.json({ ok: true, path: `/${dir}/${name}`, size: req.body.length });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }
);

app.delete("/api/media", (req, res) => {
  const dir = String(req.query.dir || "");
  const root = MEDIA_DIRS[dir];
  if (!root) return res.status(400).json({ error: "Bad dir" });
  const name = safeMediaName(req.query.name);
  if (!name) return res.status(400).json({ error: "Bad filename" });
  const full = path.join(root, name);
  if (!fs.existsSync(full)) return res.status(404).json({ error: "Not found" });
  try {
    fs.unlinkSync(full);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/models", (_req, res) => {
  const dir = path.join(__dirname, "3dfiles");
  try {
    const files = fs.readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith(".obj"))
      .map((f) => ({ name: f, path: `/3dfiles/${f}` }));
    res.json({ files });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const server = http.createServer(app);
const io = new IOServer(server, { cors: { origin: "*" } });

io.on("connection", (socket) => {
  // Admin opt-in to room list updates
  socket.on("admin:watch", (_msg, cb) => {
    socket.join("admin");
    cb?.({ ok: true, rooms: listRooms() });
  });
  socket.on("admin:unwatch", (_msg, cb) => {
    socket.leave("admin");
    cb?.({ ok: true });
  });

  // ---- room lifecycle ----
  socket.on("room:create", ({ code, hackWebhook, signalWebhook } = {}, cb) => {
    let c = (code || "").toUpperCase().trim();
    if (c) {
      if (!/^[A-Z0-9]{2,8}$/.test(c)) return cb?.({ error: "Code must be 2-8 letters/digits" });
      if (rooms.has(c)) return cb?.({ error: "Code in use" });
    } else {
      c = newRoomCode();
    }
    const room = newRoomState(c, { hackWebhook, signalWebhook });
    rooms.set(c, room);
    pushLog(room, `Room ${c} created`);
    broadcastRoomList();
    cb?.({ ok: true, code: c });
  });

  socket.on("room:close", ({ code }, cb) => {
    adminCloseRoom(code);
    broadcastRoomList();
    cb?.({ ok: true });
  });

  socket.on("room:overrides", ({ code, hackWebhook, signalWebhook }, cb) => {
    const room = rooms.get(code);
    if (!room) return cb?.({ error: "Room not found" });
    if (hackWebhook !== undefined) room.overrides.hackWebhook = hackWebhook || null;
    if (signalWebhook !== undefined) room.overrides.signalWebhook = signalWebhook || null;
    pushLog(room, "ADMIN: webhook overrides updated");
    broadcastRoomList();
    cb?.({ ok: true });
  });

  socket.on("room:list", (_msg, cb) => cb?.({ rooms: listRooms() }));

  socket.on("room:exists", ({ code }, cb) => {
    const c = (code || "").toUpperCase().trim();
    cb?.({ exists: rooms.has(c) });
  });

  // ---- player ----
  socket.on("player:join", ({ code, name }, cb) => {
    const c = (code || "").toUpperCase().trim();
    const room = rooms.get(c);
    if (!room) return cb?.({ error: "Room not found" });
    const r = addPlayer(room, name, socket.id);
    if (r.error) return cb?.({ error: r.error });
    socket.data.roomCode = c;
    socket.data.playerId = r.player.id;
    socket.join(c);
    cb?.({
      player: { id: r.player.id, name: r.player.name, code: r.player.code },
      roomCode: c,
      state: publicState(room),
    });
    broadcast(room);
    broadcastRoomList();
  });

  socket.on("player:rejoin", ({ code, playerId }, cb) => {
    const c = (code || "").toUpperCase().trim();
    const room = rooms.get(c);
    if (!room) return cb?.({ error: "Room not found" });
    const p = room.players.find((p) => p.id === playerId);
    if (!p) return cb?.({ error: "Unknown player" });
    p.socketId = socket.id;
    p.connected = true;
    socket.data.roomCode = c;
    socket.data.playerId = p.id;
    socket.join(c);
    cb?.({
      player: { id: p.id, name: p.name, code: p.code },
      roomCode: c,
      state: publicState(room),
    });
    broadcast(room);
    broadcastRoomList();
  });

  // ---- analyze ----
  socket.on("analyze:start", (_msg, cb) => {
    const room = roomOf(socket); if (!room) return cb?.({ error: "no room" });
    const r = startAnalyze(room); cb?.(r); broadcast(room);
  });
  socket.on("analyze:my", (_msg, cb) => {
    const room = roomOf(socket); const p = findPlayer(socket);
    if (!room || !p || !room.analyze) return cb?.({ error: "not in analyze" });
    const link = room.analyze.chain.find((c) => c.playerId === p.id);
    if (!link) return cb?.({ error: "not in chain" });
    cb?.({
      myCode: p.code,
      shapeIn: link.shapeIn,
      shapeOut: link.shapeOut,
      submitted: !!room.analyze.submissions[p.id],
    });
  });
  socket.on("analyze:submit", ({ targetCode }, cb) => {
    const room = roomOf(socket); const p = findPlayer(socket);
    if (!room || !p) return cb?.({ error: "no player" });
    const r = submitAnalyze(room, p.id, targetCode); cb?.(r); broadcast(room);
  });

  // ---- hack ----
  socket.on("hack:start", (_msg, cb) => {
    const room = roomOf(socket); if (!room) return cb?.({ error: "no room" });
    const r = startHack(room); cb?.(r); broadcast(room);
  });
  socket.on("hack:tap", (_msg, cb) => {
    const room = roomOf(socket); const p = findPlayer(socket);
    if (!room || !p) return cb?.({ error: "no player" });
    const r = hackTap(room, p.id); cb?.(r); broadcast(room);
  });
  socket.on("hack:exit", (_msg, cb) => {
    const room = roomOf(socket); if (!room) return cb?.({ error: "no room" });
    exitHack(room); cb?.({ ok: true }); broadcast(room);
  });

  // ---- signal ----
  socket.on("signal:start", (_msg, cb) => {
    const room = roomOf(socket); if (!room) return cb?.({ error: "no room" });
    const r = startSignal(room); cb?.(r); broadcast(room);
  });
  socket.on("signal:my", (_msg, cb) => {
    const room = roomOf(socket); const p = findPlayer(socket);
    if (!room || !p || !room.signal) return cb?.({ error: "not in signal" });
    const fragId = room.signal.assignments[p.id];
    const frag = cfg.signal.fragments.find((f) => f.id === fragId);
    cb?.({ fragment: frag, length: cfg.signal.correctOrder.length });
  });
  socket.on("signal:submit", ({ order }, cb) => {
    const room = roomOf(socket); const p = findPlayer(socket);
    if (!room || !p) return cb?.({ error: "no player" });
    const r = submitSignal(room, p.id, order); cb?.(r); broadcast(room);
  });
  socket.on("signal:exit", (_msg, cb) => {
    const room = roomOf(socket); if (!room) return cb?.({ error: "no room" });
    exitSignal(room); cb?.({ ok: true }); broadcast(room);
  });

  // ---- admin (per-room) ----
  socket.on("admin:reset", ({ code }, cb) => {
    const room = rooms.get(code); if (!room) return cb?.({ error: "no room" });
    adminReset(room); cb?.({ ok: true }); broadcast(room); broadcastRoomList();
  });
  socket.on("admin:unlockAll", ({ code }, cb) => {
    const room = rooms.get(code); if (!room) return cb?.({ error: "no room" });
    adminUnlockAll(room); cb?.({ ok: true }); broadcast(room); broadcastRoomList();
  });
  socket.on("admin:kick", ({ code, playerId }, cb) => {
    const room = rooms.get(code); if (!room) return cb?.({ error: "no room" });
    adminKick(room, playerId); cb?.({ ok: true }); broadcast(room); broadcastRoomList();
  });
  socket.on("admin:fire", ({ code, kind }, cb) => {
    const room = rooms.get(code); if (!room) return cb?.({ error: "no room" });
    fireWebhook(room, kind); cb?.({ ok: true });
  });
  socket.on("admin:log", ({ code }, cb) => {
    const room = rooms.get(code); if (!room) return cb?.({ error: "no room" });
    cb?.({ log: room.log });
  });
  socket.on("admin:reloadConfig", (_msg, cb) => {
    try { cfg = loadConfig(); cb?.({ ok: true }); }
    catch (e) { cb?.({ error: e.message }); }
    for (const room of rooms.values()) broadcast(room);
  });

  socket.on("disconnect", () => {
    const room = roomOf(socket);
    if (!room) return;
    const p = room.players.find((p) => p.socketId === socket.id);
    if (p) {
      p.connected = false;
      pushLog(room, `${p.name} disconnected`);
      reassignHackSteps(room, p.id);
    }
    broadcast(room);
    broadcastRoomList();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Second City Shadow running on http://0.0.0.0:${PORT}`);
  console.log(`Player URL:  /            (or /?room=ABC1)`);
  console.log(`Admin URL:   /admin.html`);
});
