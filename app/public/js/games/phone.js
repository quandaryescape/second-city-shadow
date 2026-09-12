// Phone — keypad UI; dialing a configured number plays a video.

import { state, showScreen, toast, playMediaOverlay } from "/js/app.js";

let dialed = "";

export function initPhone() {
  buildKeypad();
  document.getElementById("ph-back").addEventListener("click", () => showScreen("main"));
  document.getElementById("ph-erase").addEventListener("click", erase);
  document.getElementById("ph-call").addEventListener("click", call);

  // long-press 0 -> +
  let pressTimer;
  document.getElementById("ph-keypad").addEventListener("pointerdown", (e) => {
    const k = e.target.closest("[data-key]");
    if (!k) return;
    if (k.dataset.key === "0") {
      pressTimer = setTimeout(() => {
        dialed = dialed.slice(0, -1) + "+";
        updateDisplay();
      }, 600);
    }
  });
  document.getElementById("ph-keypad").addEventListener("pointerup", () => clearTimeout(pressTimer));
  document.getElementById("ph-keypad").addEventListener("pointerleave", () => clearTimeout(pressTimer));
}

export function openPhone() {
  showScreen("phone");
  dialed = "";
  updateDisplay();
  buildContacts();
}

const KEYS = [
  ["1", ""], ["2", "ABC"], ["3", "DEF"],
  ["4", "GHI"], ["5", "JKL"], ["6", "MNO"],
  ["7", "PQRS"], ["8", "TUV"], ["9", "WXYZ"],
  ["*", ""], ["0", "+"], ["#", ""],
];
function buildKeypad() {
  const kp = document.getElementById("ph-keypad");
  kp.innerHTML = "";
  for (const [k, sub] of KEYS) {
    const b = document.createElement("button");
    b.dataset.key = k;
    b.innerHTML = `${k}<span class="sub">${sub}</span>`;
    b.addEventListener("click", () => press(k));
    kp.appendChild(b);
  }
}

function buildContacts() {
  const list = document.getElementById("ph-contacts");
  const contacts = state.config?.phone?.contacts || [];
  list.innerHTML = contacts.map((c) => `
    <div class="c" data-num="${c.number}">
      <span>${escape(c.label)}</span>
      <span class="num">${escape(c.number || "—")}</span>
    </div>`).join("");
  for (const el of list.querySelectorAll(".c")) {
    el.addEventListener("click", () => {
      dialed = el.dataset.num || "";
      updateDisplay();
    });
  }
}

function press(k) {
  if (dialed.length >= 16) return;
  dialed += k;
  updateDisplay();
}

function erase() {
  dialed = dialed.slice(0, -1);
  updateDisplay();
}

function updateDisplay() {
  const d = document.getElementById("ph-display");
  d.textContent = dialed || "⏵";
}

function call() {
  if (!dialed) {
    toast("ENTER NUMBER", "err");
    return;
  }
  // try exact match first, then digits-only match
  const map = state.config?.phone?.callMap || [];
  const norm = (s) => String(s).replace(/[^\d+#*]/g, "");
  const target = norm(dialed);
  let entry = map.find((m) => m.number === dialed) || map.find((m) => norm(m.number) === target);
  if (!entry) {
    toast(state.config?.phone?.fallbackMessage || "NUMBER UNREACHABLE", "err");
    return;
  }
  playMediaOverlay(entry.src, entry.label);
}

function escape(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
