// Signal game — each player gets one audio fragment.
// Together they decide the order. Any one player submits.
// On success, server triggers ESP32 webhook.

import { emit, bus, state, showScreen, toast, playMediaOverlay } from "/js/app.js";

let myFragment = null;
let length = 0;
let pickedOrder = [];
let successHandled = false;

// Fragments are shown by their symbol (e.g. Greek letters) everywhere the
// player sees them; numeric ids stay internal (correctOrder, submissions).
function fragSymbol(id) {
  const f = state.config?.signal?.fragments?.find((x) => Number(x.id) === Number(id));
  return f?.symbol || String(id);
}

export function initSignal() {
  document.getElementById("s-back").addEventListener("click", async () => {
    await emit("signal:exit");
    showScreen("main");
  });
  document.getElementById("s-play").addEventListener("click", playFragment);
  document.getElementById("s-clear").addEventListener("click", clearOrder);
  document.getElementById("s-submit").addEventListener("click", submit);
  bus.addEventListener("state", render);
}

export async function openSignal() {
  showScreen("signal");
  document.getElementById("s-success").style.display = "none";
  pickedOrder = [];
  successHandled = false;
  await loadFragment();
  renderOrder();
  renderPad();
  render();
}

async function loadFragment() {
  const r = await emit("signal:my");
  if (r.error) { toast(r.error.toUpperCase(), "err"); return; }
  myFragment = r.fragment;
  length = r.length || 0;
  document.getElementById("s-frag-name").textContent = myFragment.label;
  const audio = document.getElementById("s-audio");
  audio.src = myFragment.audio;
  audio.load();
}

function playFragment() {
  const a = document.getElementById("s-audio");
  if (!a.src) return;
  a.currentTime = 0;
  a.play().catch((e) => toast("AUDIO BLOCKED · TAP AGAIN", "err"));
}

function renderPad() {
  const cfg = state.config?.signal;
  if (!cfg) return;
  const pad = document.getElementById("s-pad");
  pad.innerHTML = "";
  for (const f of cfg.fragments) {
    const b = document.createElement("button");
    b.textContent = f.symbol || String(f.id);
    b.dataset.id = f.id;
    b.addEventListener("click", () => pick(f.id));
    pad.appendChild(b);
  }
}

function pick(id) {
  if (pickedOrder.length >= length) return;
  if (pickedOrder.includes(Number(id))) return; // each fragment used once
  pickedOrder.push(Number(id));
  renderOrder();
  const btn = document.querySelector(`#s-pad button[data-id="${id}"]`);
  if (btn) btn.classList.add("picked");
}

function clearOrder() {
  pickedOrder = [];
  renderOrder();
  document.querySelectorAll("#s-pad button").forEach((b) => b.classList.remove("picked"));
}

function renderOrder() {
  const slots = [];
  for (let i = 0; i < length; i++) {
    slots.push(pickedOrder[i] != null ? fragSymbol(pickedOrder[i]) : "—");
  }
  document.getElementById("s-order").textContent = slots.join("   ");
  document.getElementById("s-submit").disabled = pickedOrder.length !== length;
}

async function submit() {
  if (pickedOrder.length !== length) return;
  const r = await emit("signal:submit", { order: pickedOrder });
  if (r.error) toast(r.error.toUpperCase(), "err");
  else if (!r.ok) {
    toast("INCORRECT SEQUENCE", "err");
    flash();
    clearOrder();
  } else {
    toast("SIGNAL DECRYPTED", "ok");
  }
}

function flash() {
  const o = document.getElementById("s-order");
  o.style.borderColor = "var(--red)";
  o.style.color = "var(--red)";
  setTimeout(() => { o.style.borderColor = ""; o.style.color = ""; }, 500);
}

function render() {
  // Only the visible signal screen reacts to broadcasts.
  if (!document.getElementById("screen-signal").classList.contains("active")) return;
  const s = state.serverState;
  if (!s?.signal) return;
  if (s.signal.complete) {
    document.getElementById("s-success").style.display = "block";
    if (!successHandled) {
      successHandled = true;
      playMediaOverlay(state.config?.signal?.successMedia, "SIGNAL");
    }
    // server returns the room to main after signal.successExitDelayMs
  }
}
