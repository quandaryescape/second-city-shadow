// Analyze game — circular shape-chain puzzle.
// Each player sees their incoming and outgoing shapes plus their own code.
// They must find the player whose INCOMING == their OUTGOING and enter
// that player's code.

import { emit, bus, state, showScreen, toast, shapeSvg } from "/js/app.js";

let myLink = null; // { myCode, shapeIn, shapeOut, submitted }
let submitting = false;

export function initAnalyze() {
  document.getElementById("a-submit").addEventListener("click", submitGuess);
  document.getElementById("a-target-code").addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitGuess();
  });
  bus.addEventListener("state", () => renderProgress());
}

export async function openAnalyze() {
  showScreen("analyze");
  document.getElementById("a-success").style.display = "none";
  document.getElementById("a-target-code").value = "";
  await loadMyLink();
  renderProgress();
}

async function loadMyLink() {
  const r = await emit("analyze:my");
  if (r.error) {
    toast(r.error.toUpperCase(), "err");
    return;
  }
  myLink = r;
  document.getElementById("a-shape-in").innerHTML = shapeSvg(r.shapeIn, "in");
  document.getElementById("a-shape-out").innerHTML = shapeSvg(r.shapeOut, "out");
  document.getElementById("a-mycode").textContent = r.myCode;
  setSubmittedUI(!!r.submitted);
}

function setSubmittedUI(done) {
  const submit = document.getElementById("a-submit");
  const input = document.getElementById("a-target-code");
  if (done) {
    submit.textContent = "✓ LINK CONFIRMED";
    submit.disabled = true;
    input.disabled = true;
  } else {
    submit.textContent = "SUBMIT LINK ▸";
    submit.disabled = false;
    input.disabled = false;
  }
}

async function submitGuess() {
  if (submitting) return;
  const v = document.getElementById("a-target-code").value.trim();
  if (!v) { toast("CODE REQUIRED", "err"); return; }
  submitting = true;
  const r = await emit("analyze:submit", { targetCode: v });
  submitting = false;
  if (r.error) { toast(r.error.toUpperCase(), "err"); return; }
  if (r.ok) {
    toast("LINK CONFIRMED", "ok");
    setSubmittedUI(true);
  } else {
    toast("INVALID LINK", "err");
    document.getElementById("a-target-code").value = "";
    flashCard();
  }
}

function flashCard() {
  const card = document.getElementById("a-card");
  card.style.borderColor = "var(--red)";
  setTimeout(() => { card.style.borderColor = ""; }, 350);
}

function renderProgress() {
  const s = state.serverState;
  if (!s || !s.analyze) return;
  const submitted = s.analyze.submittedCount || 0;
  const total = s.analyze.total || s.players.length || 1;
  document.getElementById("a-count").textContent = `${submitted}/${total}`;
  const pct = Math.round((submitted / total) * 100);
  document.getElementById("a-progress").style.width = pct + "%";
  document.getElementById("a-chainstat").textContent = pct + "%";

  if (s.analyze.complete) {
    document.getElementById("a-success").style.display = "block";
    setTimeout(() => showScreen("main"), 2200);
  }
}
