// Blueprint quadrant editor for the Setup Console.
//
// Renders the 8 section OBJs exploded exactly like the player viewer
// (js/viewer/blueprint.js). Click a section (or its list row) to select it,
// then edit its number, code, name, model file and explode offset. Labels
// re-render live.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import {
  viewPosition, facingLabel, cameraAzimuthDeg, degToRad,
  makeCameraGlide, buildViewBar, markActiveView,
} from "/js/viewer/viewutils.js";

let api = null;
let scene, camera, renderer, controls, container, raf;
let group = null, assembly = null;
let sectionGroups = [];
let glide = null;
let selectedIndex = -1;
let mounted = false;
let pointerDownInfo = null;
let modelFiles = [];

const raycaster = new THREE.Raycaster();
const pointerVec = new THREE.Vector2();

function cfg() { return api.getDraft().blueprint; }

export async function mountQuadrantsEditor(a) {
  api = a;
  unmountQuadrantsEditor();
  mounted = true;

  container = document.getElementById("qd-viewer");
  const w = container.clientWidth, h = container.clientHeight;

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 1000);
  camera.position.set(...viewPosition("front", 8.2));

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(w, h);
  container.appendChild(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.minDistance = 2;
  controls.maxDistance = 14;
  controls.autoRotate = false;
  controls.autoRotateSpeed = 0.8;
  glide = makeCameraGlide(camera, controls);

  scene.add(new THREE.AmbientLight(0xffffff, 0.7));

  try {
    const r = await fetch("/api/models").then((x) => x.json());
    modelFiles = r.files || [];
  } catch { modelFiles = []; }

  await loadSections();
  if (!mounted) return;
  renderList();
  renderForm();

  wireOrientation();

  renderer.domElement.addEventListener("pointerdown", onPointerDown);
  renderer.domElement.addEventListener("pointerup", onPointerUp);
  window.addEventListener("resize", onResize);
  window.addEventListener("qd:explode", applyExplode);
  loop();
}

export function unmountQuadrantsEditor() {
  mounted = false;
  cancelAnimationFrame(raf);
  raf = null;
  window.removeEventListener("resize", onResize);
  window.removeEventListener("qd:explode", applyExplode);
  if (renderer) {
    renderer.domElement.removeEventListener("pointerdown", onPointerDown);
    renderer.domElement.removeEventListener("pointerup", onPointerUp);
    renderer.dispose();
    renderer.domElement?.remove?.();
    renderer = null;
  }
  if (scene && group) {
    scene.remove(group);
    group.traverse((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); o.material?.map?.dispose?.(); });
  }
  scene = null; group = null; assembly = null;
  sectionGroups = [];
  selectedIndex = -1;
  glide = null;
  lastFacing = "";
}

function onResize() {
  if (!container || !renderer) return;
  const w = container.clientWidth, h = container.clientHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

async function loadSections() {
  const c = cfg();
  const sections = c.sections || [];
  const color = new THREE.Color(c.wireframeColor || "#7ad7ff");

  group = new THREE.Group();
  group.rotation.y = degToRad(c?.frontYawDeg);
  scene.add(group);
  assembly = new THREE.Group();
  group.add(assembly);

  const loader = new OBJLoader();
  const loaded = await Promise.all(sections.map((s) =>
    new Promise((resolve) => {
      loader.load(s.model, (obj) => resolve({ s, obj }), undefined, () => resolve({ s, obj: null }));
    })
  ));
  if (!mounted) return;

  sectionGroups = [];
  loaded.forEach(({ s, obj }, idx) => {
    const sg = new THREE.Group();
    sg.userData.sectionIndex = idx;
    const mat = new THREE.MeshBasicMaterial({ color, wireframe: true, transparent: true, opacity: 0.55 });
    sg.userData.material = mat;
    if (obj) {
      obj.traverse((child) => {
        if (child.isMesh) {
          const m = new THREE.Mesh(child.geometry, mat);
          m.userData.sectionIndex = idx;
          sg.add(m);
        }
      });
    } else {
      const fallback = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.6, 0.6), mat);
      const off = s.offset || [0, 0, 0];
      fallback.position.set(off[0] * 0.5, off[1] * 0.5, off[2] * 0.5);
      fallback.userData.sectionIndex = idx;
      sg.add(fallback);
    }
    assembly.add(sg);
    sectionGroups.push(sg);
  });

  const combined = new THREE.Box3();
  for (const sg of sectionGroups) {
    const sbox = new THREE.Box3().setFromObject(sg);
    sg.userData.localBox = sbox;
    if (!sbox.isEmpty()) combined.union(sbox);
  }
  if (combined.isEmpty()) combined.set(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));

  const center = combined.getCenter(new THREE.Vector3());
  const sizeLen = combined.getSize(new THREE.Vector3()).length() || 1;
  const scale = 3.2 / sizeLen;
  assembly.position.copy(center).multiplyScalar(-scale);
  assembly.scale.setScalar(scale);

  for (const sg of sectionGroups) {
    const localBox = sg.userData.localBox;
    let sectionCenter, direction;
    if (!localBox.isEmpty()) {
      sectionCenter = localBox.getCenter(new THREE.Vector3());
      direction = sectionCenter.clone().sub(center);
    } else {
      const off = sg.userData.sectionOffsetFallback || [0, 0, 0];
      direction = new THREE.Vector3(...off);
      sectionCenter = center.clone().add(direction);
    }
    sg.userData.direction = direction;
    sg.userData.sectionCenter = sectionCenter;
    sg.userData.labelScale = 0.55 / scale;
    sg.userData.labelOffset = sizeLen * 0.18;
  }
  rebuildLabels();
  applyExplode();
}

function rebuildLabels() {
  const c = cfg();
  const color = new THREE.Color(c.wireframeColor || "#7ad7ff");
  sectionGroups.forEach((sg, idx) => {
    if (sg.userData.labelSprite) {
      sg.remove(sg.userData.labelSprite);
      sg.userData.labelSprite.material.map?.dispose?.();
      sg.userData.labelSprite.material.dispose?.();
    }
    const s = c.sections[idx];
    if (!s) return;
    const isSel = idx === selectedIndex;
    const sprite = makeLabel(String(s.id), s.code, isSel ? new THREE.Color("#f5b32a") : color);
    sprite.position.copy(sg.userData.sectionCenter);
    const dir = sg.userData.direction;
    if (dir.length() > 0.001) {
      sprite.position.add(dir.clone().normalize().multiplyScalar(sg.userData.labelOffset));
    }
    const t = sg.userData.labelScale;
    sprite.scale.set(t, t * 0.55, 1);
    sg.add(sprite);
    sg.userData.labelSprite = sprite;

    // highlight selected section's wireframe
    sg.userData.material.opacity = isSel ? 0.95 : 0.4;
    sg.userData.material.color.set(isSel ? "#f5b32a" : color);
  });
}

function makeLabel(idText, codeText, color) {
  const w = 256, h = 140;
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "rgba(5, 6, 7, 0.92)";
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = "#" + color.getHexString();
  ctx.lineWidth = 4;
  ctx.strokeRect(2, 2, w - 4, h - 4);
  ctx.fillStyle = "#" + color.getHexString();
  ctx.font = "bold 80px JetBrains Mono, Consolas, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(idText, w / 2, 60);
  ctx.font = "bold 22px JetBrains Mono, Consolas, monospace";
  ctx.fillStyle = "#cccccc";
  ctx.fillText(codeText || "", w / 2, 116);
  const tex = new THREE.CanvasTexture(c);
  tex.minFilter = THREE.LinearFilter;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  const sp = new THREE.Sprite(mat);
  sp.renderOrder = 999;
  return sp;
}

function applyExplode() {
  const factor = (cfg().explodeFactor ?? 1.6) - 1;
  for (const sg of sectionGroups) {
    if (sg.userData?.direction) {
      sg.position.copy(sg.userData.direction).multiplyScalar(factor);
    }
  }
}

// ---------- orientation ----------
function wireOrientation() {
  const bar = document.getElementById("qd-views");
  buildViewBar(bar, {
    spinning: false,
    onView: (name) => glide.toView(name),
    onSpin: (on) => { controls.autoRotate = on; if (on) glide.cancel(); },
  });
  markActiveView(bar, "front");

  const c = cfg();
  const yawInput = document.getElementById("qd-front-yaw");
  yawInput.value = Math.round(Number(c.frontYawDeg) || 0);
  yawInput.oninput = () => applyFrontYaw(Number(yawInput.value) || 0);

  const spin = document.getElementById("qd-spin-default");
  spin.checked = c.autoRotate !== false;
  document.getElementById("qd-spin-row").classList.toggle("on", spin.checked);
  spin.onchange = () => {
    c.autoRotate = spin.checked;
    document.getElementById("qd-spin-row").classList.toggle("on", spin.checked);
    api.markDirty();
  };

  document.getElementById("qd-set-front").onclick = () => {
    const yaw = (Number(cfg().frontYawDeg) || 0) - cameraAzimuthDeg(camera);
    applyFrontYaw(Math.round(((yaw % 360) + 360) % 360));
    yawInput.value = Math.round(Number(cfg().frontYawDeg));
    glide.toView("front");
    markActiveView(document.getElementById("qd-views"), "front");
    api.toast("FRONT SET — SECTION CODES NOW MATCH THIS VIEW", "ok");
  };
}

function applyFrontYaw(deg) {
  cfg().frontYawDeg = deg;
  if (group) group.rotation.y = degToRad(deg);
  api.markDirty();
}

let lastFacing = "";
function updateFacing() {
  const el = document.getElementById("qd-facing");
  if (!el) return;
  const label = facingLabel(camera);
  if (label === lastFacing) return;
  lastFacing = label;
  el.textContent = "VIEW · " + label;
  markActiveView(document.getElementById("qd-views"), label.toLowerCase());
}

// ---------- selection ----------
function onPointerDown(e) {
  pointerDownInfo = { x: e.clientX, y: e.clientY, t: performance.now() };
}
function onPointerUp(e) {
  if (!pointerDownInfo) return;
  const isClick = Math.hypot(e.clientX - pointerDownInfo.x, e.clientY - pointerDownInfo.y) < 8
    && performance.now() - pointerDownInfo.t < 600;
  pointerDownInfo = null;
  if (!isClick || !assembly) return;

  const rect = renderer.domElement.getBoundingClientRect();
  pointerVec.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  pointerVec.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointerVec, camera);
  const hits = raycaster.intersectObjects(sectionGroups, true);
  const hit = hits.find((h) => h.object.userData.sectionIndex !== undefined);
  if (hit) selectSection(hit.object.userData.sectionIndex);
}

function selectSection(idx) {
  selectedIndex = idx === selectedIndex ? -1 : idx;
  rebuildLabels();
  renderList();
  renderForm();
}

// ---------- list + form ----------
function renderList() {
  const el = document.getElementById("qd-list");
  if (!el) return;
  const sections = cfg().sections || [];
  el.innerHTML = sections.map((s, i) => `
    <div class="row-item sec-row ${i === selectedIndex ? "selected" : ""}" data-i="${i}">
      <span class="id">${api.escapeHtml(s.id)}</span>
      <span class="nm">${api.escapeHtml(s.code)} · ${api.escapeHtml(s.name)}</span>
      <span class="badge">${api.escapeHtml((s.model || "").split("/").pop())}</span>
    </div>`).join("");
  for (const row of el.querySelectorAll(".sec-row")) {
    row.addEventListener("click", () => selectSection(Number(row.dataset.i)));
  }
}

function renderForm() {
  const el = document.getElementById("qd-form");
  if (!el) return;
  const sections = cfg().sections || [];
  const s = sections[selectedIndex];
  if (!s) {
    el.innerHTML = `<div class="empty">CLICK A SECTION IN THE VIEWER OR LIST TO EDIT IT</div>`;
    return;
  }
  const modelOptions = modelFiles.map((f) =>
    `<option value="${api.escapeHtml(f.path)}" ${f.path === s.model ? "selected" : ""}>${api.escapeHtml(f.name)}</option>`).join("");
  const off = s.offset || [0, 0, 0];
  el.innerHTML = `
    <div class="panel">
      <div class="grid-3">
        <div class="field"><label>NUMBER (LABEL)</label><input type="number" id="qf-id" value="${api.escapeHtml(s.id)}" /></div>
        <div class="field"><label>CODE</label><input type="text" id="qf-code" value="${api.escapeHtml(s.code)}" /></div>
        <div class="field"><label>NAME</label><input type="text" id="qf-name" value="${api.escapeHtml(s.name)}" /></div>
      </div>
      <div class="grid-2">
        <div class="field"><label>MODEL FILE</label><select id="qf-model">${modelOptions}</select></div>
        <div class="field"><label>EXPLODE OFFSET HINT (X · Y · Z)</label>
          <div class="flex">
            <input type="number" step="0.1" id="qf-ox" value="${off[0]}" />
            <input type="number" step="0.1" id="qf-oy" value="${off[1]}" />
            <input type="number" step="0.1" id="qf-oz" value="${off[2]}" />
          </div>
        </div>
      </div>
    </div>`;

  const upd = () => { api.markDirty(); rebuildLabels(); renderList(); };
  document.getElementById("qf-id").addEventListener("input", (e) => { s.id = Number(e.target.value); upd(); });
  document.getElementById("qf-code").addEventListener("input", (e) => { s.code = e.target.value.toUpperCase(); upd(); });
  document.getElementById("qf-name").addEventListener("input", (e) => { s.name = e.target.value; upd(); });
  document.getElementById("qf-model").addEventListener("change", (e) => {
    s.model = e.target.value;
    api.markDirty();
    mountQuadrantsEditor(api); // reload scene with new model
  });
  const offInput = (id, idx) => document.getElementById(id).addEventListener("input", (e) => {
    s.offset = s.offset || [0, 0, 0];
    s.offset[idx] = Number(e.target.value);
    api.markDirty();
  });
  offInput("qf-ox", 0); offInput("qf-oy", 1); offInput("qf-oz", 2);
}

// ---------- loop ----------
function loop() {
  if (!mounted) return;
  raf = requestAnimationFrame(loop);
  glide?.step();
  controls.update();
  updateFacing();
  renderer.render(scene, camera);
}
