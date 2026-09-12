// Second City Shadow — Field Ops Terminal
// Main client app: socket wiring, screen routing, shared UI helpers.

import { initAnalyze, openAnalyze } from "/js/games/analyze.js";
import { initHack, openHack } from "/js/games/hack.js";
import { initSignal, openSignal } from "/js/games/signal.js";
import { initPhone, openPhone } from "/js/games/phone.js";
import { initFeatures, openFeatures } from "/js/viewer/features.js";
import { initBlueprint, openBlueprint } from "/js/viewer/blueprint.js";

// ---------- shared bus / state ----------
export const bus = new EventTarget();
export const state = {
  player: null,        // { id, name, code }
  roomCode: null,      // the room this client is in
  serverState: null,   // last broadcast from server
  config: null,        // public config
};

const STORAGE_KEY = "scs.player";

// ---------- socket helpers ----------
const socket = window.io({ transports: ["websocket", "polling"] });
export { socket };

export function emit(event, payload = {}) {
  return new Promise((resolve) => socket.emit(event, payload, (r) => resolve(r || {})));
}

// Fires on the FIRST connect and on every reconnect. Phones drop the socket
// constantly (screen dim, wifi power save, backgrounding), so this must never
// move a player who is already mid-game — it used to force the hub screen on
// every blip, which is how players got yanked out of the hack.
socket.on("connect", async () => {
  const saved = sessionStorage.getItem(STORAGE_KEY);
  if (!saved) return;
  try {
    const p = JSON.parse(saved);
    if (!p.code || !p.id) return;
    const r = await emit("player:rejoin", { code: p.code, playerId: p.id });
    if (r.error) {
      sessionStorage.removeItem(STORAGE_KEY);
      return;
    }
    state.player = r.player;
    state.roomCode = r.roomCode;
    renderHeader();
    // Only a fresh page load (still sitting on the entry screen) lands on the
    // hub. Otherwise leave the screen alone and let the phase router decide.
    if (document.getElementById("screen-entry").classList.contains("active")) {
      showScreen("main");
    }
    if (r.state) ingestState(r.state);
  } catch {
    sessionStorage.removeItem(STORAGE_KEY);
  }
});

function ingestState(s) {
  state.serverState = s;
  bus.dispatchEvent(new CustomEvent("state", { detail: s }));
  applyServerState(s);
}

socket.on("state", ingestState);

socket.on("kicked", () => {
  sessionStorage.removeItem(STORAGE_KEY);
  toast("REMOVED FROM SESSION", "err");
  state.player = null;
  showScreen("entry");
});

// ---------- screens ----------
const screens = ["entry", "main", "analyze", "hack", "signal", "features", "blueprint", "phone"];
export function showScreen(name) {
  for (const s of screens) {
    document.getElementById("screen-" + s)?.classList.toggle("active", s === name);
  }
  bus.dispatchEvent(new CustomEvent("screen:" + name));
}

// ---------- modal ----------
export function confirmModal({ title = "CONFIRM", body = "", okText = "CONFIRM ▸", cancelText = "CANCEL" } = {}) {
  return new Promise((resolve) => {
    const back = document.getElementById("modal");
    document.getElementById("modal-title").textContent = title;
    document.getElementById("modal-body").textContent = body;
    document.getElementById("modal-ok").textContent = okText;
    document.getElementById("modal-cancel").textContent = cancelText;
    back.classList.add("open");
    const ok = () => { cleanup(); resolve(true); };
    const cancel = () => { cleanup(); resolve(false); };
    const cleanup = () => {
      back.classList.remove("open");
      document.getElementById("modal-ok").removeEventListener("click", ok);
      document.getElementById("modal-cancel").removeEventListener("click", cancel);
    };
    document.getElementById("modal-ok").addEventListener("click", ok);
    document.getElementById("modal-cancel").addEventListener("click", cancel);
  });
}

// ---------- shared media overlay ----------
// Videos open the full-screen "call" overlay (it sits above every screen,
// so phase changes underneath don't interrupt playback). Audio plays inline.
export function playMediaOverlay(src, label = "") {
  if (!src) return;
  const isVideo = /\.(mp4|webm|mov|m4v)(\?.*)?$/i.test(src);
  if (!isVideo) {
    const a = new Audio(src);
    a.play().catch(() => {});
    return;
  }
  const overlay = document.getElementById("video-overlay");
  const v = document.getElementById("video-el");
  document.getElementById("video-label").textContent = "● " + (label || "INCOMING").toUpperCase();
  v.src = src;
  v.muted = false;
  overlay.classList.add("open");
  v.play().catch(() => {
    // autoplay with sound can be blocked without a fresh gesture — retry muted
    v.muted = true;
    v.play().catch(() => {});
  });
}

export function closeMediaOverlay() {
  const overlay = document.getElementById("video-overlay");
  const v = document.getElementById("video-el");
  v.pause();
  v.removeAttribute("src");
  v.load();
  overlay.classList.remove("open");
}

// ---------- toast ----------
let toastTimer = null;
export function toast(msg, kind = "") {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.className = "toast show " + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2400);
}

// ---------- shapes ----------
const SHAPE_PATHS = {
  triangle: '<polygon class="sh-stroke" points="50,10 92,84 8,84"/>',
  circle: '<circle class="sh-stroke" cx="50" cy="50" r="40"/>',
  square: '<rect class="sh-stroke" x="14" y="14" width="72" height="72"/>',
  pentagon: '<polygon class="sh-stroke" points="50,10 92,40 76,86 24,86 8,40"/>',
  hexagon: '<polygon class="sh-stroke" points="50,8 88,30 88,70 50,92 12,70 12,30"/>',
  star: '<polygon class="sh-stroke" points="50,8 60,38 92,38 66,58 76,90 50,70 24,90 34,58 8,38 40,38"/>',
  diamond: '<polygon class="sh-stroke" points="50,8 92,50 50,92 8,50"/>',
  cross: '<polygon class="sh-stroke" points="34,8 66,8 66,34 92,34 92,66 66,66 66,92 34,92 34,66 8,66 8,34 34,34"/>',
};
export function shapeSvg(name, dir = "") {
  const p = SHAPE_PATHS[name] || SHAPE_PATHS.circle;
  return `<svg class="shape-svg ${dir}" viewBox="0 0 100 100">${p}</svg>`;
}

// ---------- header / status ----------
function renderHeader() {
  if (!state.player) return;
  document.getElementById("m-name").textContent = state.player.name;
  document.getElementById("m-code").textContent = state.player.code;
  const roomEl = document.getElementById("m-room");
  if (roomEl) roomEl.textContent = state.roomCode || "—";
}

function renderRoster(s) {
  const r = document.getElementById("m-roster");
  r.innerHTML = (s.players || [])
    .map((p) => `
      <div class="p ${p.connected ? "" : "off"}">
        <span class="nm">${escapeHtml(p.name)}</span>
        <span class="st">${p.connected ? "● ONLINE" : "○ OFFLINE"}</span>
      </div>`)
    .join("");
}

function renderHubLocks(s) {
  const u = s.unlocked || {};
  for (const [key, btnId] of [
    ["hack", "b-hack"],
    ["features", "b-features"],
    ["blueprint", "b-blueprint"],
    ["signal", "b-signal"],
  ]) {
    const btn = document.getElementById(btnId);
    if (!btn) continue;
    btn.disabled = !u[key];
    const lock = btn.querySelector(".lock");
    if (lock) lock.style.display = u[key] ? "none" : "inline";
  }
}

function applyServerState(s) {
  if (!state.player) return;
  // hub render
  renderRoster(s);
  renderHubLocks(s);

  // status text
  const statusEl = document.getElementById("m-status-text");
  if (statusEl) {
    if (s.phase === "lobby") statusEl.textContent = `AWAITING AGENTS · ${s.players.length} ONLINE`;
    else if (s.phase === "main") statusEl.textContent = `READY · ${s.players.length} AGENTS LINKED`;
    else statusEl.textContent = `ACTIVE: ${s.phase.toUpperCase()}`;
  }

  // auto-route to active phase if we are not in a sub-screen by user choice
  const active = document.querySelector(".screen.active")?.id?.replace("screen-", "");
  if (s.phase === "analyze" && active !== "analyze") openAnalyze();
  else if (s.phase === "hack" && active !== "hack") openHack();
  else if (s.phase === "signal" && active !== "signal") openSignal();
  else if (s.phase === "main" && (active === "analyze" || active === "hack" || active === "signal")) {
    showScreen("main");
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
export { escapeHtml };

// ---------- entry / join ----------
async function init() {
  // load public config
  state.config = await fetch("/api/config").then((r) => r.json());
  applyConfigText();
  document.getElementById("video-end").addEventListener("click", closeMediaOverlay);
  document.getElementById("video-el").addEventListener("ended", closeMediaOverlay);
  initEntry();
  initHub();
  initAnalyze();
  initHack();
  initSignal();
  initPhone();
  initFeatures();
  initBlueprint();
}

function applyConfigText() {
  const c = state.config;
  if (!c) return;
  // theme colors from config restyle the whole terminal
  if (c.ui?.primaryColor) document.documentElement.style.setProperty("--amber", c.ui.primaryColor);
  if (c.ui?.accentColor) document.documentElement.style.setProperty("--red", c.ui.accentColor);
  if (c.ui?.lockedLabel) {
    for (const el of document.querySelectorAll(".lock")) el.textContent = c.ui.lockedLabel;
  }
  if (c.ui?.heroTitle) document.getElementById("hero-title").textContent = c.ui.heroTitle;
  if (c.ui?.heroSubtitle) document.getElementById("hero-sub").textContent = c.ui.heroSubtitle;
  document.getElementById("m-title").textContent = c.ui?.heroTitle ?? "SECOND CITY SHADOW";
  document.getElementById("a-instructions").querySelector("span").textContent = c.analyze?.instructions ?? "";
  document.getElementById("h-instructions").textContent = c.hack?.instructions ?? "";
  document.getElementById("s-instructions").textContent = c.signal?.instructions ?? "";
  document.getElementById("f-instructions").textContent = c.features?.instructions ?? "";
  document.getElementById("bp-instructions").textContent = c.blueprint?.instructions ?? "";
  document.getElementById("ph-title").textContent = c.phone?.title ?? "ENCRYPTED COMMS";
  document.getElementById("a-success-msg").textContent = c.analyze?.successMessage ?? "";
  document.getElementById("s-success-msg").textContent = c.signal?.successMessage ?? "";
}

function initEntry() {
  const roomInput = document.getElementById("entry-room");
  const nameInput = document.getElementById("entry-name");
  const go = document.getElementById("entry-go");

  // prefill room code from ?room=ABCD
  const params = new URLSearchParams(location.search);
  const presetRoom = params.get("room");
  if (presetRoom) roomInput.value = presetRoom.toUpperCase();

  // force uppercase as user types
  roomInput.addEventListener("input", () => {
    const start = roomInput.selectionStart;
    roomInput.value = roomInput.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (start != null) roomInput.setSelectionRange(start, start);
  });

  const join = async () => {
    const code = roomInput.value.trim().toUpperCase();
    const name = nameInput.value.trim();
    if (!code) { toast("ROOM CODE REQUIRED", "err"); roomInput.focus(); return; }
    if (!name) { toast("CALLSIGN REQUIRED", "err"); nameInput.focus(); return; }
    go.disabled = true;
    const r = await emit("player:join", { code, name });
    go.disabled = false;
    if (r.error) { toast(r.error.toUpperCase(), "err"); return; }
    state.player = r.player;
    state.roomCode = r.roomCode;
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ id: r.player.id, code: r.roomCode }));
    renderHeader();
    showScreen("main");
    toast(`WELCOME, ${r.player.name.toUpperCase()}`, "ok");
  };
  go.addEventListener("click", join);
  for (const el of [roomInput, nameInput]) {
    el.addEventListener("keydown", (e) => { if (e.key === "Enter") join(); });
  }

  // Auto-jump from room field to name when 4 chars entered
  roomInput.addEventListener("input", () => {
    if (roomInput.value.length >= 4 && !nameInput.value) nameInput.focus();
  });
}

function initHub() {
  document.getElementById("b-analyze").addEventListener("click", async () => {
    const ok = await confirmModal({
      title: "BEGIN ANALYSIS",
      body: "All connected agents will be pulled into the analysis protocol. Confirm?",
      okText: "BEGIN ▸",
    });
    if (!ok) return;
    const r = await emit("analyze:start");
    if (r.error) toast(r.error.toUpperCase(), "err");
  });

  document.getElementById("b-phone").addEventListener("click", () => openPhone());

  document.getElementById("b-hack").addEventListener("click", async () => {
    const ok = await confirmModal({
      title: "INITIATE HACK",
      body: "All agents must be ready. Cooperative timing required. Confirm?",
      okText: "INITIATE ▸",
    });
    if (!ok) return;
    const r = await emit("hack:start");
    if (r.error) toast(r.error.toUpperCase(), "err");
  });

  document.getElementById("b-signal").addEventListener("click", async () => {
    const ok = await confirmModal({
      title: "INTERCEPT SIGNAL",
      body: "All agents will receive a fragment. Decode together. Confirm?",
      okText: "INTERCEPT ▸",
    });
    if (!ok) return;
    const r = await emit("signal:start");
    if (r.error) toast(r.error.toUpperCase(), "err");
  });

  document.getElementById("b-features").addEventListener("click", () => openFeatures());
  document.getElementById("b-blueprint").addEventListener("click", () => openBlueprint());
}

document.addEventListener("DOMContentLoaded", init);
