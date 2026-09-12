// Hack game — cooperative tap sequence.
// Server picks a random sequence of player IDs. The current player's
// phone shows TAP, others show WAIT. Wrong tap or timeout = fail.
//
// All timing (countdown, step timeout, retry after fail, exit after
// success) is owned by the SERVER. This module never schedules hack:start
// or hack:exit on a timer — stale client timers were restarting/aborting
// games for the whole room.

import { emit, bus, state, showScreen, confirmModal, playMediaOverlay } from "/js/app.js";

let lastStatus = null;

export function initHack() {
  document.getElementById("h-tap").addEventListener("click", onTap);
  document.getElementById("h-back").addEventListener("click", abort);
  bus.addEventListener("state", render);
}

export function openHack() {
  showScreen("hack");
  lastStatus = null;
  render();
}

async function onTap() {
  const s = state.serverState;
  if (!s?.hack || s.hack.status !== "running") return;
  if (s.hack.currentPlayerId !== state.player.id) return;
  await emit("hack:tap");
}

async function abort() {
  const ok = await confirmModal({
    title: "ABORT HACK",
    body: "This aborts the intrusion for ALL agents. Confirm?",
    okText: "ABORT ▸",
  });
  if (!ok) return;
  await emit("hack:exit");
  showScreen("main");
}

function render() {
  // Only the visible hack screen should react to broadcasts.
  if (!document.getElementById("screen-hack").classList.contains("active")) return;
  const s = state.serverState;
  if (!s?.hack) return;
  const tap = document.getElementById("h-tap");
  const status = document.getElementById("h-status");
  const dots = document.getElementById("h-dots");

  // dots
  dots.innerHTML = "";
  for (let i = 0; i < s.hack.length; i++) {
    const d = document.createElement("div");
    d.className = "d";
    if (i < s.hack.step) d.classList.add("done");
    if (i === s.hack.step && s.hack.status === "running") d.classList.add("active");
    dots.appendChild(d);
  }

  tap.classList.remove("go", "fail", "success");

  if (s.hack.status === "countdown") {
    tap.textContent = "STAND BY";
    status.textContent = "INITIATING…";
    lastStatus = null;
  } else if (s.hack.status === "running") {
    if (s.hack.currentPlayerId === state.player.id) {
      tap.textContent = "TAP";
      tap.classList.add("go");
      status.textContent = `STEP ${s.hack.step + 1} / ${s.hack.length} · YOUR TURN`;
      if (lastStatus !== "myturn") vibrate(60);
      lastStatus = "myturn";
    } else {
      tap.textContent = "WAIT";
      const others = s.players.find((p) => p.id === s.hack.currentPlayerId);
      status.textContent = others
        ? `STEP ${s.hack.step + 1} / ${s.hack.length} · ${others.name.toUpperCase()}`
        : `STEP ${s.hack.step + 1} / ${s.hack.length}`;
      lastStatus = "wait";
    }
  } else if (s.hack.status === "fail") {
    tap.textContent = s.hack.waiting ? "HOLD" : "RESET";
    tap.classList.add("fail");
    status.textContent = s.hack.waiting
      ? `PAUSED · ${String(s.hack.waiting).toUpperCase()}`
      : "INTRUSION FAILED · RESTARTING…";
    if (lastStatus !== "fail") vibrate([60, 40, 60]);
    lastStatus = "fail"; // server auto-restarts the sequence
  } else if (s.hack.status === "success") {
    tap.textContent = "✓";
    tap.classList.add("success");
    status.textContent = state.config?.hack?.successMessage || "INTRUSION SUCCESSFUL";
    if (lastStatus !== "success") {
      vibrate([100, 60, 100]);
      playMediaOverlay(state.config?.hack?.successMedia, "INTRUSION");
    }
    lastStatus = "success"; // server exits the room to main shortly
  }
}

function vibrate(p) {
  if (navigator.vibrate) navigator.vibrate(p);
}
