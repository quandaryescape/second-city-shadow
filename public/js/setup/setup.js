// Setup Console — full content editor for puzzles.json.
// Loads the raw config, binds every tab's form to a draft object,
// and PUTs the whole thing back to /api/admin/config on save.

import { mountPointsEditor, unmountPointsEditor } from "/js/setup/points-editor.js";
import { mountQuadrantsEditor, unmountQuadrantsEditor } from "/js/setup/quadrants-editor.js";

export let draft = null;
let dirty = false;
let activeTab = null;

const KNOWN_SHAPES = ["triangle", "circle", "square", "pentagon", "hexagon", "star", "diamond", "cross"];

// ---------- tiny helpers ----------
export function $(sel, root = document) { return root.querySelector(sel); }
export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
let toastTimer = null;
export function toast(msg, kind = "") {
  const el = $("#toast");
  el.textContent = msg;
  el.className = "toast show " + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}
export function markDirty() {
  dirty = true;
  renderStatus();
}
function renderStatus() {
  const st = $("#save-status");
  st.textContent = dirty ? "● UNSAVED CHANGES" : "SAVED";
  st.classList.toggle("dirty", dirty);
  $("#hdr-status").textContent = dirty ? "EDITED" : "SYNCED";
}

function fmtBytes(n) {
  if (n > 1e9) return (n / 1e9).toFixed(1) + " GB";
  if (n > 1e6) return (n / 1e6).toFixed(1) + " MB";
  if (n > 1e3) return (n / 1e3).toFixed(0) + " KB";
  return n + " B";
}

// Bind a text/number input to a draft path. get/set via closures.
function bind(input, get, set, { number = false } = {}) {
  input.value = get() ?? "";
  input.addEventListener("input", () => {
    set(number ? Number(input.value) : input.value);
    markDirty();
  });
}
function bindColor(textInput, colorInput, get, set) {
  const cur = get() || "#ffffff";
  textInput.value = cur;
  try { colorInput.value = cur; } catch { /* invalid hex */ }
  textInput.addEventListener("input", () => { set(textInput.value); try { colorInput.value = textInput.value; } catch {} markDirty(); });
  colorInput.addEventListener("input", () => { set(colorInput.value); textInput.value = colorInput.value; markDirty(); });
}

// ---------- media picker ----------
let pickerResolve = null;
export function pickMedia(dir, title = "SELECT MEDIA") {
  return new Promise((resolve) => {
    pickerResolve = resolve;
    $("#picker-title").textContent = title;
    $("#picker-back").classList.add("open");
    $("#picker-preview").style.display = "none";
    $("#picker-preview").innerHTML = "";
    $("#picker-manual").value = "";
    loadPickerList(dir);
    $("#picker-back").dataset.dir = dir;
  });
}
function closePicker(result) {
  $("#picker-back").classList.remove("open");
  $("#picker-preview").innerHTML = "";
  pickerResolve?.(result ?? null);
  pickerResolve = null;
}
async function loadPickerList(dir) {
  const list = $("#picker-list");
  list.innerHTML = `<div class="empty">LOADING…</div>`;
  try {
    const r = await fetch(`/api/media?dir=${encodeURIComponent(dir)}`).then((x) => x.json());
    if (r.error) throw new Error(r.error);
    if (!r.files.length) {
      list.innerHTML = `<div class="empty">NO FILES IN /${escapeHtml(dir)} — UPLOAD ONE ABOVE</div>`;
      return;
    }
    list.innerHTML = r.files.map((f) => `
      <div class="file" data-path="${escapeHtml(f.path)}" data-name="${escapeHtml(f.name)}">
        <span>${escapeHtml(f.name)}</span>
        <span class="sz">${fmtBytes(f.size)}</span>
        <button class="btn small" data-act="preview">▸</button>
        <button class="btn small primary" data-act="use">USE</button>
      </div>`).join("");
    for (const row of list.querySelectorAll(".file")) {
      row.querySelector("[data-act='use']").addEventListener("click", () => closePicker(row.dataset.path));
      row.querySelector("[data-act='preview']").addEventListener("click", () => {
        const slot = $("#picker-preview");
        const p = row.dataset.path;
        const isVideo = /\.(mp4|webm|mov|m4v)$/i.test(p);
        slot.innerHTML = isVideo
          ? `<video src="${escapeHtml(p)}" controls autoplay playsinline></video>`
          : `<audio src="${escapeHtml(p)}" controls autoplay></audio>`;
        slot.style.display = "block";
      });
    }
  } catch (e) {
    list.innerHTML = `<div class="empty">ERROR: ${escapeHtml(e.message)}</div>`;
  }
}
function initPicker() {
  $("#picker-cancel").addEventListener("click", () => closePicker(null));
  $("#picker-back").addEventListener("click", (e) => { if (e.target.id === "picker-back") closePicker(null); });
  $("#picker-use-manual").addEventListener("click", () => {
    const v = $("#picker-manual").value.trim();
    if (v) closePicker(v);
  });
  $("#picker-upload").addEventListener("click", () => $("#picker-file").click());
  $("#picker-file").addEventListener("change", async () => {
    const file = $("#picker-file").files[0];
    if (!file) return;
    const dir = $("#picker-back").dataset.dir;
    $("#picker-upload").textContent = "UPLOADING…";
    $("#picker-upload").disabled = true;
    try {
      const r = await fetch(`/api/media/upload?dir=${encodeURIComponent(dir)}&name=${encodeURIComponent(file.name)}`, {
        method: "POST",
        body: file,
      }).then((x) => x.json());
      if (r.error) throw new Error(r.error);
      toast("UPLOADED " + file.name.toUpperCase(), "ok");
      loadPickerList(dir);
    } catch (e) {
      toast(("UPLOAD FAILED: " + e.message).toUpperCase(), "err");
    } finally {
      $("#picker-upload").textContent = "⬆ UPLOAD NEW FILE";
      $("#picker-upload").disabled = false;
      $("#picker-file").value = "";
    }
  });
}

// ---------- tabs ----------
const TABS = {
  points: renderPoints,
  quadrants: renderQuadrants,
  analyze: renderAnalyze,
  hack: renderHack,
  signal: renderSignal,
  phone: renderPhone,
  system: renderSystem,
  theme: renderTheme,
  raw: renderRaw,
};

function switchTab(name) {
  if (activeTab === "points") unmountPointsEditor();
  if (activeTab === "quadrants") unmountQuadrantsEditor();
  activeTab = name;
  for (const b of $("#tabs").querySelectorAll("button")) {
    b.classList.toggle("active", b.dataset.tab === name);
  }
  for (const pane of document.querySelectorAll(".tab-pane")) {
    pane.classList.toggle("active", pane.id === "pane-" + name);
  }
  TABS[name]?.();
}

// ---------- POINTS tab ----------
function renderPoints() {
  const pane = $("#pane-points");
  pane.innerHTML = `
    <div class="strip"><span class="t">LOCK-PICK POINT EDITOR</span><span class="pip"></span></div>
    <div class="hint">TAP "ADD POINT" THEN CLICK THE MODEL SURFACE TO DROP A MARKER. DRAG TO ORBIT · PINCH/WHEEL TO ZOOM.</div>
    <div class="editor-toolbar">
      <button class="btn small" id="pt-add">＋ ADD POINT</button>
      <button class="btn small ghost" id="pt-reload">RELOAD MODEL</button>
    </div>
    <div class="viewer editor mode-orbit brk" id="pt-viewer">
      <span class="brk-tr"></span><span class="brk-bl"></span>
      <div class="corner-tag">POINT EDITOR</div>
      <div class="corner-tag r" id="pt-mode-tag">ORBIT MODE</div>
      <div class="legend" id="pt-facing">VIEW · FRONT</div>
    </div>
    <div class="view-bar" id="pt-views"></div>
    <div class="orient-row">
      <button class="btn small" id="pt-set-front">◎ USE THIS VIEW AS FRONT</button>
      <label class="mini-label">FRONT YAW°</label>
      <input type="number" id="pt-front-yaw" step="1" />
      <label class="check-row compact" id="pt-spin-row">
        <input type="checkbox" id="pt-spin-default" /><span>SPIN BY DEFAULT</span>
      </label>
    </div>
    <div class="hint">ORBIT UNTIL THE BOMB’S REAL FRONT FACES YOU, THEN "USE THIS VIEW AS FRONT" — THAT BECOMES THE FRONT BUTTON FOR PLAYERS, AND FIXES WHICH SIDE SECTION-BASED MARKERS LAND ON.</div>
    <div class="strip"><span class="t">POINTS</span></div>
    <div class="rows" id="pt-list"></div>
    <div class="spacer"></div>
    <div class="strip"><span class="t">VIEWER SETTINGS</span></div>
    <div class="grid-2">
      <div class="field">
        <label>MODEL</label>
        <select id="pt-model"></select>
      </div>
      <div class="field">
        <label>INSTRUCTIONS (PLAYER-FACING)</label>
        <input type="text" id="pt-instructions" />
      </div>
      <div class="field">
        <label>WIREFRAME COLOR</label>
        <div class="color-row"><input type="color" id="pt-wire-c" /><input type="text" id="pt-wire-t" /></div>
      </div>
      <div class="field">
        <label>MARKER COLOR</label>
        <div class="color-row"><input type="color" id="pt-hl-c" /><input type="text" id="pt-hl-t" /></div>
      </div>
    </div>`;

  bind($("#pt-instructions"), () => draft.features.instructions, (v) => (draft.features.instructions = v));
  bindColor($("#pt-wire-t"), $("#pt-wire-c"), () => draft.features.wireframeColor, (v) => (draft.features.wireframeColor = v));
  bindColor($("#pt-hl-t"), $("#pt-hl-c"), () => draft.features.highlightColor, (v) => (draft.features.highlightColor = v));

  // model dropdown
  fetch("/api/models").then((r) => r.json()).then((r) => {
    const sel = $("#pt-model");
    const cur = draft.features.modelPath;
    sel.innerHTML = (r.files || []).map((f) =>
      `<option value="${escapeHtml(f.path)}" ${f.path === cur ? "selected" : ""}>${escapeHtml(f.name)}</option>`).join("");
    if (cur && ![...sel.options].some((o) => o.value === cur)) {
      sel.insertAdjacentHTML("afterbegin", `<option value="${escapeHtml(cur)}" selected>${escapeHtml(cur)}</option>`);
    }
    sel.addEventListener("change", () => {
      draft.features.modelPath = sel.value;
      markDirty();
      mountPointsEditor(api); // reload scene with new model
    });
  });

  mountPointsEditor(api);
}

// ---------- QUADRANTS tab ----------
function renderQuadrants() {
  const pane = $("#pane-quadrants");
  pane.innerHTML = `
    <div class="strip"><span class="t">BLUEPRINT QUADRANT EDITOR</span><span class="pip"></span></div>
    <div class="hint">CLICK A SECTION IN THE VIEWER (OR THE LIST) TO SELECT IT, THEN EDIT ITS NUMBER, CODE AND NAME BELOW.</div>
    <div class="editor-toolbar">
      <div class="field grow" style="margin:0">
        <label>EXPLODE FACTOR: <span id="qd-explode-val"></span></label>
        <input type="range" id="qd-explode" min="1" max="3" step="0.05" />
      </div>
    </div>
    <div class="viewer editor mode-orbit brk" id="qd-viewer">
      <span class="brk-tr"></span><span class="brk-bl"></span>
      <div class="corner-tag">QUADRANT EDITOR</div>
      <div class="corner-tag r">CLICK TO SELECT</div>
      <div class="legend" id="qd-facing">VIEW · FRONT</div>
    </div>
    <div class="view-bar" id="qd-views"></div>
    <div class="orient-row">
      <button class="btn small" id="qd-set-front">◎ USE THIS VIEW AS FRONT</button>
      <label class="mini-label">FRONT YAW°</label>
      <input type="number" id="qd-front-yaw" step="1" />
      <label class="check-row compact" id="qd-spin-row">
        <input type="checkbox" id="qd-spin-default" /><span>SPIN BY DEFAULT</span>
      </label>
    </div>
    <div class="hint">SECTION CODES ASSUME FRONT = THE SIDE THE "FRONT" VIEW SHOWS. SET IT HERE SO FTL/FBR ETC. MATCH THE PHYSICAL PROP.</div>
    <div class="strip"><span class="t">SELECTED SECTION</span></div>
    <div id="qd-form"><div class="empty">NO SECTION SELECTED</div></div>
    <div class="strip"><span class="t">ALL SECTIONS</span></div>
    <div class="rows" id="qd-list"></div>
    <div class="spacer"></div>
    <div class="grid-2">
      <div class="field">
        <label>BLUEPRINT INSTRUCTIONS (PLAYER-FACING)</label>
        <input type="text" id="qd-instructions" />
      </div>
      <div class="field">
        <label>WIREFRAME COLOR</label>
        <div class="color-row"><input type="color" id="qd-wire-c" /><input type="text" id="qd-wire-t" /></div>
      </div>
    </div>`;

  bind($("#qd-instructions"), () => draft.blueprint.instructions, (v) => (draft.blueprint.instructions = v));
  bindColor($("#qd-wire-t"), $("#qd-wire-c"), () => draft.blueprint.wireframeColor, (v) => (draft.blueprint.wireframeColor = v));

  const slider = $("#qd-explode");
  slider.value = draft.blueprint.explodeFactor ?? 1.6;
  $("#qd-explode-val").textContent = Number(slider.value).toFixed(2);
  slider.addEventListener("input", () => {
    draft.blueprint.explodeFactor = Number(slider.value);
    $("#qd-explode-val").textContent = Number(slider.value).toFixed(2);
    markDirty();
    window.dispatchEvent(new CustomEvent("qd:explode"));
  });

  mountQuadrantsEditor(api);
}

// ---------- ANALYZE tab ----------
function renderAnalyze() {
  const pane = $("#pane-analyze");
  const a = draft.analyze;
  pane.innerHTML = `
    <div class="strip"><span class="t">ANALYZE · SHAPE CHAIN</span><span class="pip"></span></div>
    <div class="hint">EACH PLAYER GETS AN IN/OUT SHAPE PAIR FORMING A RING. SHAPES BELOW ARE THE POOL DRAWN FROM (NEED ≥ MAX PLAYERS).</div>
    <div class="strip"><span class="t">SHAPE POOL</span></div>
    <div class="grid-4" id="an-shapes"></div>
    <div class="spacer"></div>
    <div class="check-row ${a.shuffleShapes ? "on" : ""}" id="an-shuffle-row">
      <input type="checkbox" id="an-shuffle" ${a.shuffleShapes ? "checked" : ""} />
      <label for="an-shuffle" style="cursor:pointer">SHUFFLE SHAPE ASSIGNMENT EACH GAME</label>
    </div>
    <div class="spacer"></div>
    <div class="field">
      <label>INSTRUCTIONS (PLAYER-FACING)</label>
      <textarea id="an-instructions"></textarea>
    </div>
    <div class="field">
      <label>SUCCESS MESSAGE</label>
      <input type="text" id="an-success" />
    </div>`;

  const shapesEl = $("#an-shapes");
  shapesEl.innerHTML = KNOWN_SHAPES.map((s) => `
    <div class="check-row ${a.shapes.includes(s) ? "on" : ""}" data-shape="${s}">
      <input type="checkbox" ${a.shapes.includes(s) ? "checked" : ""} />
      <span>${s.toUpperCase()}</span>
    </div>`).join("");
  for (const row of shapesEl.querySelectorAll(".check-row")) {
    const cb = row.querySelector("input");
    const toggle = () => {
      const s = row.dataset.shape;
      if (cb.checked) { if (!a.shapes.includes(s)) a.shapes.push(s); }
      else a.shapes = a.shapes.filter((x) => x !== s);
      row.classList.toggle("on", cb.checked);
      markDirty();
    };
    cb.addEventListener("change", toggle);
    row.addEventListener("click", (e) => { if (e.target !== cb) { cb.checked = !cb.checked; toggle(); } });
  }

  $("#an-shuffle").addEventListener("change", (e) => {
    a.shuffleShapes = e.target.checked;
    $("#an-shuffle-row").classList.toggle("on", e.target.checked);
    markDirty();
  });
  bind($("#an-instructions"), () => a.instructions, (v) => (a.instructions = v));
  bind($("#an-success"), () => a.successMessage, (v) => (a.successMessage = v));
}

// ---------- HACK tab ----------
function renderHack() {
  const pane = $("#pane-hack");
  const h = draft.hack;
  pane.innerHTML = `
    <div class="strip"><span class="t">HACK · REACTION SEQUENCE</span><span class="pip"></span></div>
    <div class="grid-3">
      <div class="field">
        <label>SEQUENCE LENGTH (TAPS)</label>
        <input type="number" id="hk-len" min="1" max="50" />
      </div>
      <div class="field">
        <label>PER-STEP TIMEOUT (MS)</label>
        <input type="number" id="hk-timeout" min="500" step="250" />
      </div>
      <div class="field">
        <label>COUNTDOWN BEFORE START (MS)</label>
        <input type="number" id="hk-countdown" min="0" step="500" />
      </div>
      <div class="field">
        <label>RETRY DELAY AFTER FAIL (MS)</label>
        <input type="number" id="hk-retry" min="0" step="100" />
      </div>
      <div class="field">
        <label>RETURN TO HUB AFTER SUCCESS (MS)</label>
        <input type="number" id="hk-exit" min="0" step="100" />
      </div>
    </div>
    <div class="field">
      <label>INSTRUCTIONS (PLAYER-FACING)</label>
      <textarea id="hk-instructions"></textarea>
    </div>
    <div class="strip"><span class="t">ON SUCCESS</span></div>
    <div class="hint">WHAT HAPPENS WHEN THE SEQUENCE IS COMPLETED — ANY COMBINATION OF MESSAGE, MEDIA, AND WEBHOOK.</div>
    <div id="hk-outcome"></div>
    <div class="strip"><span class="t">ESP32 LIGHT PATTERN</span><span class="pip"></span></div>
    <div class="hint">TAP A LIGHT TO TOGGLE IT. THIS GRID IS SENT IN THE HACK WEBHOOK SO THE ESP32 KNOWS WHAT TO DISPLAY. NUMBERS ARE THE LIGHT INDEX IN THE PAYLOAD.</div>
    <div class="editor-toolbar">
      <button class="btn small" id="hk-lp-all">ALL ON</button>
      <button class="btn small" id="hk-lp-none">ALL OFF</button>
      <button class="btn small" id="hk-lp-inv">INVERT</button>
    </div>
    <div class="lightgrid" id="hk-lp-grid"></div>
    <div class="hint">WEBHOOK BODY PREVIEW — TEST IT WITH "FIRE HACK WEBHOOK" IN THE HOST CONSOLE.</div>
    <div class="payload-preview" id="hk-lp-preview"></div>`;
  bind($("#hk-len"), () => h.sequenceLength, (v) => (h.sequenceLength = v), { number: true });
  bind($("#hk-timeout"), () => h.stepTimeoutMs, (v) => (h.stepTimeoutMs = v), { number: true });
  bind($("#hk-countdown"), () => h.preStartCountdownMs, (v) => (h.preStartCountdownMs = v), { number: true });
  bind($("#hk-retry"), () => h.failRetryDelayMs ?? 1600, (v) => (h.failRetryDelayMs = v), { number: true });
  bind($("#hk-exit"), () => h.successExitDelayMs ?? 2500, (v) => (h.successExitDelayMs = v), { number: true });
  bind($("#hk-instructions"), () => h.instructions, (v) => (h.instructions = v));
  renderSuccessOutcome($("#hk-outcome"), "hk", h);
  renderLightPattern(h);
}

// 3-wide x 2-tall grid of on/off lights, sent to the ESP32 in the hack webhook.
function renderLightPattern(h) {
  const DEFAULT_ROWS = 2, DEFAULT_COLS = 3;
  if (!Array.isArray(h.lightPattern) || !h.lightPattern.length || !Array.isArray(h.lightPattern[0])) {
    h.lightPattern = Array.from({ length: DEFAULT_ROWS }, () => Array(DEFAULT_COLS).fill(0));
  }
  const grid = h.lightPattern;
  const cols = grid[0].length;
  const gridEl = $("#hk-lp-grid");
  gridEl.style.gridTemplateColumns = `repeat(${cols}, auto)`;

  const draw = () => {
    gridEl.innerHTML = grid.map((row, r) => row.map((v, c) => {
      const idx = r * cols + c + 1;
      return `<button class="cell ${v ? "on" : ""}" data-r="${r}" data-c="${c}">
                <span class="bulb"></span><span>L${idx} ${v ? "ON" : "OFF"}</span>
              </button>`;
    }).join("")).join("");
    for (const cell of gridEl.querySelectorAll(".cell")) {
      cell.addEventListener("click", () => {
        const r = Number(cell.dataset.r), c = Number(cell.dataset.c);
        grid[r][c] = grid[r][c] ? 0 : 1;
        markDirty();
        draw();
      });
    }
    drawPreview();
  };

  const drawPreview = () => {
    const lights = grid.flat().map((v) => (v ? 1 : 0));
    let mask = 0;
    lights.forEach((v, i) => { if (v) mask |= 1 << i; });
    // Hand-rolled so the arrays stay on one line each — a pretty-printed
    // nested array is one digit per line and unreadable.
    const base = Object.entries(draft.esp32.hackPayload || {})
      .map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`);
    const rowsTxt = grid.map((r) => `[${r.map((v) => (v ? 1 : 0)).join(",")}]`).join(", ");
    $("#hk-lp-preview").textContent = [
      "{",
      ...base,
      `  "room": "7K2P",`,
      `  "pattern": [${rowsTxt}],`,
      `  "lights": [${lights.join(",")}],`,
      `  "bits": "${lights.join("")}",`,
      `  "mask": ${mask},`,
      `  "rows": ${grid.length},`,
      `  "cols": ${cols}`,
      "}",
    ].join("\n");
  };

  const setAll = (fn) => {
    for (let r = 0; r < grid.length; r++) {
      for (let c = 0; c < grid[r].length; c++) grid[r][c] = fn(grid[r][c]);
    }
    markDirty();
    draw();
  };
  $("#hk-lp-all").addEventListener("click", () => setAll(() => 1));
  $("#hk-lp-none").addEventListener("click", () => setAll(() => 0));
  $("#hk-lp-inv").addEventListener("click", () => setAll((v) => (v ? 0 : 1)));

  draw();
}

// Shared "on success" editor: message + media (video or audio) + webhook toggle.
function renderSuccessOutcome(container, prefix, gameCfg) {
  container.innerHTML = `
    <div class="grid-2">
      <div class="field">
        <label>SUCCESS MESSAGE (SHOWN ON SCREEN)</label>
        <input type="text" id="${prefix}-oc-msg" />
      </div>
      <div class="field">
        <label>SUCCESS MEDIA (VIDEO PLAYS FULL-SCREEN · AUDIO PLAYS INLINE · BLANK = NONE)</label>
        <div class="flex">
          <input type="text" id="${prefix}-oc-media" class="grow" placeholder="(none)" />
          <button class="btn small" id="${prefix}-oc-vid">VIDEO</button>
          <button class="btn small" id="${prefix}-oc-aud">AUDIO</button>
          <button class="btn small ghost" id="${prefix}-oc-clear">✕</button>
        </div>
      </div>
    </div>
    <div class="check-row ${gameCfg.fireWebhook !== false ? "on" : ""}" id="${prefix}-oc-hook-row">
      <input type="checkbox" id="${prefix}-oc-hook" ${gameCfg.fireWebhook !== false ? "checked" : ""} />
      <label for="${prefix}-oc-hook" style="cursor:pointer">FIRE ESP32 WEBHOOK</label>
    </div>`;
  bind($(`#${prefix}-oc-msg`), () => gameCfg.successMessage, (v) => (gameCfg.successMessage = v));
  bind($(`#${prefix}-oc-media`), () => gameCfg.successMedia ?? "", (v) => (gameCfg.successMedia = v));
  const setMedia = (p) => {
    gameCfg.successMedia = p;
    $(`#${prefix}-oc-media`).value = p;
    markDirty();
  };
  $(`#${prefix}-oc-vid`).addEventListener("click", async () => {
    const p = await pickMedia("video", "SELECT SUCCESS VIDEO");
    if (p) setMedia(p);
  });
  $(`#${prefix}-oc-aud`).addEventListener("click", async () => {
    const p = await pickMedia("audio/signal", "SELECT SUCCESS AUDIO");
    if (p) setMedia(p);
  });
  $(`#${prefix}-oc-clear`).addEventListener("click", () => setMedia(""));
  $(`#${prefix}-oc-hook`).addEventListener("change", (e) => {
    gameCfg.fireWebhook = e.target.checked;
    $(`#${prefix}-oc-hook-row`).classList.toggle("on", e.target.checked);
    markDirty();
  });
}

// ---------- SIGNAL tab ----------
function renderSignal() {
  const pane = $("#pane-signal");
  const s = draft.signal;
  // migrate legacy field name
  if (s.successMedia === undefined && s.successAudio) s.successMedia = s.successAudio;
  const symOf = (id) => {
    const f = s.fragments.find((x) => Number(x.id) === Number(id));
    return f?.symbol || String(id);
  };
  pane.innerHTML = `
    <div class="strip"><span class="t">SIGNAL · AUDIO FRAGMENTS</span><span class="pip"></span></div>
    <div class="rows" id="sg-frags"></div>
    <div class="spacer-sm"></div>
    <button class="btn small full" id="sg-add">＋ ADD FRAGMENT</button>
    <div class="strip"><span class="t">CORRECT ORDER (THE ANSWER)</span></div>
    <div class="hint">TAP A CHIP TO REMOVE IT · TAP A FRAGMENT SYMBOL BELOW TO APPEND IT. PLAYERS SEE THE SYMBOLS, NOT THE IDS.</div>
    <div class="chips" id="sg-order"></div>
    <div class="order-pad-mini" id="sg-pad"></div>
    <div class="spacer"></div>
    <div class="grid-2">
      <div class="field">
        <label>INSTRUCTIONS (PLAYER-FACING)</label>
        <input type="text" id="sg-instructions" />
      </div>
      <div class="field">
        <label>RETURN TO HUB AFTER SUCCESS (MS)</label>
        <input type="number" id="sg-exit" min="0" step="100" />
      </div>
    </div>
    <div class="strip"><span class="t">ON SUCCESS</span></div>
    <div class="hint">WHAT HAPPENS WHEN THE CORRECT ORDER IS SUBMITTED — ANY COMBINATION OF MESSAGE, MEDIA, AND WEBHOOK.</div>
    <div id="sg-outcome"></div>`;

  bind($("#sg-instructions"), () => s.instructions, (v) => (s.instructions = v));
  bind($("#sg-exit"), () => s.successExitDelayMs ?? 3000, (v) => (s.successExitDelayMs = v), { number: true });
  renderSuccessOutcome($("#sg-outcome"), "sg", s);
  $("#sg-add").addEventListener("click", () => {
    const nextId = Math.max(0, ...s.fragments.map((f) => Number(f.id))) + 1;
    s.fragments.push({ id: nextId, symbol: String(nextId), label: `FRAGMENT ${nextId}`, audio: "" });
    markDirty();
    renderFrags();
    renderOrderBuilder();
  });

  function renderFrags() {
    const el = $("#sg-frags");
    if (!s.fragments.length) { el.innerHTML = `<div class="empty">NO FRAGMENTS</div>`; return; }
    el.innerHTML = s.fragments.map((f, i) => `
      <div class="row-item" style="grid-template-columns:58px 70px 1fr 1.4fr auto auto auto" data-i="${i}">
        <input type="number" value="${escapeHtml(f.id)}" data-f="id" title="internal id" />
        <input type="text" value="${escapeHtml(f.symbol ?? "")}" data-f="symbol" placeholder="α" title="symbol shown to players" />
        <input type="text" value="${escapeHtml(f.label)}" data-f="label" placeholder="LABEL" />
        <input type="text" value="${escapeHtml(f.audio)}" data-f="audio" placeholder="/audio/signal/frag1.mp3" />
        <button class="btn small" data-act="pick">PICK</button>
        <button class="btn small" data-act="play">▸</button>
        <button class="btn small danger" data-act="del">✕</button>
      </div>`).join("");
    for (const row of el.querySelectorAll(".row-item")) {
      const i = Number(row.dataset.i);
      const frag = s.fragments[i];
      for (const inp of row.querySelectorAll("input")) {
        inp.addEventListener("input", () => {
          const k = inp.dataset.f;
          frag[k] = k === "id" ? Number(inp.value) : inp.value;
          markDirty();
          if (k === "id" || k === "symbol") renderOrderBuilder();
        });
      }
      row.querySelector("[data-act='pick']").addEventListener("click", async () => {
        const p = await pickMedia("audio/signal", "SELECT FRAGMENT AUDIO");
        if (p) { frag.audio = p; row.querySelector("[data-f='audio']").value = p; markDirty(); }
      });
      row.querySelector("[data-act='play']").addEventListener("click", () => {
        if (!frag.audio) return toast("NO AUDIO SET", "err");
        new Audio(frag.audio).play().catch(() => toast("PLAYBACK FAILED", "err"));
      });
      row.querySelector("[data-act='del']").addEventListener("click", () => {
        s.fragments.splice(i, 1);
        s.correctOrder = s.correctOrder.filter((id) => s.fragments.some((f) => Number(f.id) === Number(id)));
        markDirty();
        renderFrags();
        renderOrderBuilder();
      });
    }
  }

  function renderOrderBuilder() {
    const chips = $("#sg-order");
    chips.innerHTML = s.correctOrder.length
      ? s.correctOrder.map((id, i) => `<span class="chip" data-i="${i}" title="fragment ${escapeHtml(id)} — tap to remove">${escapeHtml(symOf(id))}</span>`).join("")
      : `<span class="hint" style="margin:auto">EMPTY — TAP FRAGMENT SYMBOLS BELOW</span>`;
    for (const chip of chips.querySelectorAll(".chip")) {
      chip.addEventListener("click", () => {
        s.correctOrder.splice(Number(chip.dataset.i), 1);
        markDirty();
        renderOrderBuilder();
      });
    }
    const pad = $("#sg-pad");
    pad.innerHTML = s.fragments.map((f) => `<button data-id="${escapeHtml(f.id)}" title="fragment ${escapeHtml(f.id)}">${escapeHtml(f.symbol || f.id)}</button>`).join("");
    for (const b of pad.querySelectorAll("button")) {
      b.addEventListener("click", () => {
        s.correctOrder.push(Number(b.dataset.id));
        markDirty();
        renderOrderBuilder();
      });
    }
  }

  renderFrags();
  renderOrderBuilder();
}

// ---------- PHONE tab ----------
function renderPhone() {
  const pane = $("#pane-phone");
  const p = draft.phone;
  pane.innerHTML = `
    <div class="strip"><span class="t">PHONE · CALL ROUTING</span><span class="pip"></span></div>
    <div class="grid-2">
      <div class="field">
        <label>SCREEN TITLE</label>
        <input type="text" id="ph-title" />
      </div>
      <div class="field">
        <label>WRONG-NUMBER MESSAGE</label>
        <input type="text" id="ph-fallback" />
      </div>
    </div>
    <div class="strip"><span class="t">CALL MAP — NUMBER → VIDEO</span></div>
    <div class="hint">DIALING A MATCHING NUMBER PLAYS THE VIDEO FULL-SCREEN. DASHES/SPACES IN THE DIALED NUMBER ARE IGNORED.</div>
    <div class="rows" id="ph-map"></div>
    <div class="spacer-sm"></div>
    <button class="btn small full" id="ph-map-add">＋ ADD NUMBER</button>
    <div class="strip"><span class="t">DIRECTORY (SHOWN TO PLAYERS)</span></div>
    <div class="rows" id="ph-contacts"></div>
    <div class="spacer-sm"></div>
    <button class="btn small full" id="ph-contact-add">＋ ADD CONTACT</button>`;

  bind($("#ph-title"), () => p.title, (v) => (p.title = v));
  bind($("#ph-fallback"), () => p.fallbackMessage, (v) => (p.fallbackMessage = v));

  function renderMap() {
    const el = $("#ph-map");
    if (!p.callMap.length) { el.innerHTML = `<div class="empty">NO NUMBERS CONFIGURED</div>`; return; }
    el.innerHTML = p.callMap.map((m, i) => `
      <div class="row-item" style="grid-template-columns:110px 1fr 1.4fr auto auto auto" data-i="${i}">
        <input type="text" value="${escapeHtml(m.number)}" data-f="number" placeholder="555-0001" />
        <input type="text" value="${escapeHtml(m.label)}" data-f="label" placeholder="CALLER LABEL" />
        <input type="text" value="${escapeHtml(m.src)}" data-f="src" placeholder="/video/villain.mp4" />
        <button class="btn small" data-act="pick">PICK</button>
        <button class="btn small" data-act="play">▸</button>
        <button class="btn small danger" data-act="del">✕</button>
      </div>`).join("");
    for (const row of el.querySelectorAll(".row-item")) {
      const i = Number(row.dataset.i);
      const entry = p.callMap[i];
      for (const inp of row.querySelectorAll("input")) {
        inp.addEventListener("input", () => { entry[inp.dataset.f] = inp.value; markDirty(); });
      }
      row.querySelector("[data-act='pick']").addEventListener("click", async () => {
        const path = await pickMedia("video", "SELECT VIDEO");
        if (path) { entry.src = path; entry.kind = "video"; row.querySelector("[data-f='src']").value = path; markDirty(); }
      });
      row.querySelector("[data-act='play']").addEventListener("click", () => {
        if (entry.src) window.open(entry.src, "_blank");
        else toast("NO VIDEO SET", "err");
      });
      row.querySelector("[data-act='del']").addEventListener("click", () => {
        p.callMap.splice(i, 1); markDirty(); renderMap();
      });
    }
  }

  function renderContacts() {
    const el = $("#ph-contacts");
    if (!p.contacts.length) { el.innerHTML = `<div class="empty">EMPTY DIRECTORY</div>`; return; }
    el.innerHTML = p.contacts.map((c, i) => `
      <div class="row-item" style="grid-template-columns:1fr 150px auto" data-i="${i}">
        <input type="text" value="${escapeHtml(c.label)}" data-f="label" placeholder="LABEL" />
        <input type="text" value="${escapeHtml(c.number)}" data-f="number" placeholder="555-0001 (blank = decoy)" />
        <button class="btn small danger" data-act="del">✕</button>
      </div>`).join("");
    for (const row of el.querySelectorAll(".row-item")) {
      const i = Number(row.dataset.i);
      for (const inp of row.querySelectorAll("input")) {
        inp.addEventListener("input", () => { p.contacts[i][inp.dataset.f] = inp.value; markDirty(); });
      }
      row.querySelector("[data-act='del']").addEventListener("click", () => {
        p.contacts.splice(i, 1); markDirty(); renderContacts();
      });
    }
  }

  $("#ph-map-add").addEventListener("click", () => {
    p.callMap.push({ number: "", kind: "video", src: "", label: "" });
    markDirty(); renderMap();
  });
  $("#ph-contact-add").addEventListener("click", () => {
    p.contacts.push({ label: "", number: "" });
    markDirty(); renderContacts();
  });

  renderMap();
  renderContacts();
}

// ---------- SYSTEM tab (session + esp32) ----------
function renderSystem() {
  const pane = $("#pane-system");
  const se = draft.session;
  const esp = draft.esp32;
  const UNLOCKABLE = ["hack", "features", "blueprint", "signal"];
  pane.innerHTML = `
    <div class="strip"><span class="t">SESSION RULES</span><span class="pip"></span></div>
    <div class="grid-3">
      <div class="field"><label>MIN PLAYERS</label><input type="number" id="sy-min" min="1" max="16" /></div>
      <div class="field"><label>MAX PLAYERS</label><input type="number" id="sy-max" min="1" max="16" /></div>
      <div class="field"><label>PLAYER CODE LENGTH (DIGITS)</label><input type="number" id="sy-codelen" min="2" max="6" /></div>
    </div>
    <div class="field">
      <label>MODULES UNLOCKED WHEN ANALYZE COMPLETES</label>
      <div class="grid-4" id="sy-unlocks"></div>
    </div>
    <div class="strip"><span class="t">ESP32 WEBHOOKS</span></div>
    <div class="hint">FIRED WHEN THE MATCHING PUZZLE IS SOLVED. TEST THEM WITH THE "FIRE" BUTTONS IN THE HOST CONSOLE. ROOMS CAN OVERRIDE PER-KIT.</div>
    <div class="grid-2">
      <div class="field"><label>HACK WEBHOOK URL</label><input type="text" id="sy-hack-url" /></div>
      <div class="field"><label>SIGNAL WEBHOOK URL</label><input type="text" id="sy-signal-url" /></div>
      <div class="field"><label>HTTP METHOD</label>
        <select id="sy-method"><option>POST</option><option>GET</option><option>PUT</option></select>
      </div>
      <div class="field"><label>TIMEOUT (MS)</label><input type="number" id="sy-timeout" min="500" step="500" /></div>
      <div class="field"><label>HACK PAYLOAD (JSON)</label><textarea id="sy-hack-payload"></textarea></div>
      <div class="field"><label>SIGNAL PAYLOAD (JSON)</label><textarea id="sy-signal-payload"></textarea></div>
    </div>`;

  bind($("#sy-min"), () => se.minPlayers, (v) => (se.minPlayers = v), { number: true });
  bind($("#sy-max"), () => se.maxPlayers, (v) => (se.maxPlayers = v), { number: true });
  bind($("#sy-codelen"), () => se.playerCodeLength, (v) => (se.playerCodeLength = v), { number: true });
  bind($("#sy-hack-url"), () => esp.hackWebhook, (v) => (esp.hackWebhook = v));
  bind($("#sy-signal-url"), () => esp.signalWebhook, (v) => (esp.signalWebhook = v));
  bind($("#sy-timeout"), () => esp.webhookTimeoutMs, (v) => (esp.webhookTimeoutMs = v), { number: true });
  $("#sy-method").value = esp.webhookMethod || "POST";
  $("#sy-method").addEventListener("change", (e) => { esp.webhookMethod = e.target.value; markDirty(); });

  const unl = $("#sy-unlocks");
  unl.innerHTML = UNLOCKABLE.map((k) => `
    <div class="check-row ${se.autoUnlockOnAnalyzeSuccess.includes(k) ? "on" : ""}" data-k="${k}">
      <input type="checkbox" ${se.autoUnlockOnAnalyzeSuccess.includes(k) ? "checked" : ""} />
      <span>${k.toUpperCase()}</span>
    </div>`).join("");
  for (const row of unl.querySelectorAll(".check-row")) {
    const cb = row.querySelector("input");
    const toggle = () => {
      const k = row.dataset.k;
      if (cb.checked) { if (!se.autoUnlockOnAnalyzeSuccess.includes(k)) se.autoUnlockOnAnalyzeSuccess.push(k); }
      else se.autoUnlockOnAnalyzeSuccess = se.autoUnlockOnAnalyzeSuccess.filter((x) => x !== k);
      row.classList.toggle("on", cb.checked);
      markDirty();
    };
    cb.addEventListener("change", toggle);
    row.addEventListener("click", (e) => { if (e.target !== cb) { cb.checked = !cb.checked; toggle(); } });
  }

  const bindJson = (el, get, set) => {
    el.value = JSON.stringify(get() ?? {}, null, 2);
    el.addEventListener("input", () => {
      try {
        set(JSON.parse(el.value));
        el.style.borderColor = "";
        markDirty();
      } catch {
        el.style.borderColor = "var(--red)";
      }
    });
  };
  bindJson($("#sy-hack-payload"), () => esp.hackPayload, (v) => (esp.hackPayload = v));
  bindJson($("#sy-signal-payload"), () => esp.signalPayload, (v) => (esp.signalPayload = v));
}

// ---------- THEME tab ----------
function renderTheme() {
  const pane = $("#pane-theme");
  const u = draft.ui;
  pane.innerHTML = `
    <div class="strip"><span class="t">BRANDING &amp; THEME</span><span class="pip"></span></div>
    <div class="grid-2">
      <div class="field"><label>HERO TITLE</label><input type="text" id="th-title" /></div>
      <div class="field"><label>HERO SUBTITLE</label><input type="text" id="th-sub" /></div>
      <div class="field"><label>LOCKED LABEL</label><input type="text" id="th-locked" /></div>
      <div class="field"><label>LOBBY HINT</label><input type="text" id="th-lobby" /></div>
      <div class="field">
        <label>PRIMARY COLOR (AMBER ACCENTS)</label>
        <div class="color-row"><input type="color" id="th-prim-c" /><input type="text" id="th-prim-t" /></div>
      </div>
      <div class="field">
        <label>ACCENT COLOR (RED ALERTS)</label>
        <div class="color-row"><input type="color" id="th-acc-c" /><input type="text" id="th-acc-t" /></div>
      </div>
    </div>
    <div class="hint">COLORS RESTYLE THE WHOLE PLAYER APP LIVE (WIREFRAMES, BUTTONS, MARKERS DEFAULT TO THESE).</div>`;
  bind($("#th-title"), () => u.heroTitle, (v) => (u.heroTitle = v));
  bind($("#th-sub"), () => u.heroSubtitle, (v) => (u.heroSubtitle = v));
  bind($("#th-locked"), () => u.lockedLabel, (v) => (u.lockedLabel = v));
  bind($("#th-lobby"), () => u.lobbyHint, (v) => (u.lobbyHint = v));
  bindColor($("#th-prim-t"), $("#th-prim-c"), () => u.primaryColor, (v) => (u.primaryColor = v));
  bindColor($("#th-acc-t"), $("#th-acc-c"), () => u.accentColor, (v) => (u.accentColor = v));
}

// ---------- RAW tab ----------
function renderRaw() {
  const pane = $("#pane-raw");
  pane.innerHTML = `
    <div class="strip"><span class="t">RAW CONFIG (ADVANCED)</span><span class="pip"></span></div>
    <div class="hint">DIRECT JSON EDITING. "APPLY TO EDITOR" PARSES THIS TEXT INTO THE FORM TABS — SAVE STILL HAPPENS FROM THE SAVE BAR.</div>
    <textarea class="raw-json" id="raw-text" spellcheck="false"></textarea>
    <div class="spacer-sm"></div>
    <div class="flex">
      <button class="btn small grow" id="raw-apply">APPLY TO EDITOR</button>
      <button class="btn small ghost grow" id="raw-refresh">REFRESH FROM EDITOR</button>
    </div>`;
  const ta = $("#raw-text");
  ta.value = JSON.stringify(draft, null, 2);
  $("#raw-refresh").addEventListener("click", () => { ta.value = JSON.stringify(draft, null, 2); });
  $("#raw-apply").addEventListener("click", () => {
    try {
      draft = JSON.parse(ta.value);
      markDirty();
      toast("APPLIED — REVIEW TABS, THEN SAVE", "ok");
    } catch (e) {
      toast("INVALID JSON: " + e.message.toUpperCase(), "err");
    }
  });
}

// ---------- editors' API surface ----------
const api = {
  getDraft: () => draft,
  markDirty,
  toast,
  escapeHtml,
  $,
};

// ---------- save / revert ----------
async function save() {
  const btn = $("#btn-save");
  btn.disabled = true;
  btn.textContent = "SAVING…";
  try {
    const r = await fetch("/api/admin/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(draft),
    }).then((x) => x.json());
    if (r.error) throw new Error(r.error);
    dirty = false;
    renderStatus();
    toast("SAVED & APPLIED TO LIVE ROOMS", "ok");
  } catch (e) {
    toast(("SAVE FAILED: " + e.message).toUpperCase(), "err");
  } finally {
    btn.disabled = false;
    btn.innerHTML = "SAVE &amp; APPLY ▸";
  }
}

async function load() {
  draft = await fetch("/api/admin/config").then((r) => r.json());
  dirty = false;
  renderStatus();
}

async function revert() {
  if (dirty && !confirm("Discard unsaved changes and reload from disk?")) return;
  await load();
  switchTab(activeTab || "points");
  toast("RELOADED FROM DISK", "ok");
}

// ---------- boot ----------
(async function boot() {
  initPicker();
  await load();
  for (const b of $("#tabs").querySelectorAll("button")) {
    b.addEventListener("click", () => switchTab(b.dataset.tab));
  }
  $("#btn-save").addEventListener("click", save);
  $("#btn-revert").addEventListener("click", revert);
  window.addEventListener("beforeunload", (e) => {
    if (dirty) { e.preventDefault(); e.returnValue = ""; }
  });
  switchTab("points");
})();
