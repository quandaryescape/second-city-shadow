// 3D lock-pick point editor for the Setup Console.
//
// Loads the features model with the exact same centering/scaling as the
// player-facing viewer (js/viewer/features.js), so a clicked surface point
// saved here lands in the identical spot in-game. Points are stored as
// `modelPosition` (raw OBJ-space coords) — the most stable representation,
// already supported by the player viewer. Legacy `section` / `direction`
// entries still render (resolved by raycast) and can be repositioned, which
// converts them to fixed modelPosition entries.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import {
  viewPosition, facingLabel, cameraAzimuthDeg, degToRad,
  makeCameraGlide, buildViewBar, markActiveView,
} from "/js/viewer/viewutils.js";

let api = null;
let scene, camera, renderer, controls, container, raf;
let model = null, collider = null, markerHost = null;
let modelOriginalCenter = new THREE.Vector3();
let modelScale = 1;
let glide = null;
let addMode = false;
let moveIndex = -1;     // index of point armed for repositioning
let selectedIndex = -1;
let mounted = false;
let pointerDownInfo = null;

const raycaster = new THREE.Raycaster();
const pointerVec = new THREE.Vector2();

function cfg() { return api.getDraft().features; }
function points() {
  const f = cfg();
  if (!Array.isArray(f.lockPickPoints)) f.lockPickPoints = [];
  return f.lockPickPoints;
}

export async function mountPointsEditor(a) {
  api = a;
  unmountPointsEditor();
  mounted = true;

  container = document.getElementById("pt-viewer");
  const w = container.clientWidth, h = container.clientHeight;

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 1000);
  camera.position.set(...viewPosition("front", 4.6));

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(w, h);
  container.appendChild(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 1.2;
  controls.maxDistance = 9;
  controls.autoRotate = false;   // editing wants a still model
  controls.autoRotateSpeed = 0.9;
  glide = makeCameraGlide(camera, controls);

  scene.add(new THREE.AmbientLight(0xffffff, 0.6));

  await loadModel();
  if (!mounted) return; // unmounted while loading
  rebuildMarkers();
  renderList();
  wireToolbar();

  renderer.domElement.addEventListener("pointerdown", onPointerDown);
  renderer.domElement.addEventListener("pointerup", onPointerUp);
  window.addEventListener("resize", onResize);
  loop();
}

export function unmountPointsEditor() {
  mounted = false;
  cancelAnimationFrame(raf);
  raf = null;
  window.removeEventListener("resize", onResize);
  if (renderer) {
    renderer.domElement.removeEventListener("pointerdown", onPointerDown);
    renderer.domElement.removeEventListener("pointerup", onPointerUp);
    renderer.dispose();
    renderer.domElement?.remove?.();
    renderer = null;
  }
  if (scene && model) {
    scene.remove(model);
    model.traverse((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); o.material?.map?.dispose?.(); });
  }
  scene = null; model = null; collider = null; markerHost = null;
  addMode = false; moveIndex = -1; selectedIndex = -1; glide = null; lastFacing = "";
}

function onResize() {
  if (!container || !renderer) return;
  const w = container.clientWidth, h = container.clientHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

function wireToolbar() {
  document.getElementById("pt-add").onclick = () => setAddMode(!addMode);
  document.getElementById("pt-reload").onclick = () => mountPointsEditor(api);

  const bar = document.getElementById("pt-views");
  buildViewBar(bar, {
    spinning: false,
    onView: (name) => glide.toView(name),
    onSpin: (on) => { controls.autoRotate = on; if (on) glide.cancel(); },
  });
  markActiveView(bar, "front");

  const f = cfg();
  const yawInput = document.getElementById("pt-front-yaw");
  yawInput.value = Math.round(Number(f.frontYawDeg) || 0);
  yawInput.oninput = () => applyFrontYaw(Number(yawInput.value) || 0);

  const spin = document.getElementById("pt-spin-default");
  spin.checked = f.autoRotate !== false;
  document.getElementById("pt-spin-row").classList.toggle("on", spin.checked);
  spin.onchange = () => {
    f.autoRotate = spin.checked;
    document.getElementById("pt-spin-row").classList.toggle("on", spin.checked);
    api.markDirty();
  };

  document.getElementById("pt-set-front").onclick = () => {
    // Rotate the model so whatever the camera is looking at becomes the front.
    const yaw = (Number(cfg().frontYawDeg) || 0) - cameraAzimuthDeg(camera);
    applyFrontYaw(Math.round(((yaw % 360) + 360) % 360));
    yawInput.value = Math.round(Number(cfg().frontYawDeg));
    glide.toView("front");
    markActiveView(document.getElementById("pt-views"), "front");
    api.toast("FRONT SET — PLAYERS SEE THIS AS THE FRONT", "ok");
  };

  updateModeUi();
}

function applyFrontYaw(deg) {
  cfg().frontYawDeg = deg;
  if (model) model.rotation.y = degToRad(deg);
  api.markDirty();
  rebuildMarkers();   // section/direction points re-resolve against the new front
  renderList();
}

let lastFacing = "";
function updateFacing() {
  const el = document.getElementById("pt-facing");
  if (!el) return;
  const label = facingLabel(camera);
  if (label === lastFacing) return;
  lastFacing = label;
  el.textContent = "VIEW · " + label;
  markActiveView(document.getElementById("pt-views"), label.toLowerCase());
}

function setAddMode(on) {
  addMode = on;
  if (on) moveIndex = -1;
  updateModeUi();
}

function updateModeUi() {
  const addBtn = document.getElementById("pt-add");
  const tag = document.getElementById("pt-mode-tag");
  if (!addBtn) return;
  addBtn.classList.toggle("on", addMode);
  addBtn.textContent = addMode ? "✕ CANCEL ADD" : "＋ ADD POINT";
  container?.classList.toggle("mode-orbit", !addMode && moveIndex < 0);
  if (tag) {
    tag.textContent = addMode ? "TAP SURFACE TO ADD"
      : moveIndex >= 0 ? `TAP SURFACE TO MOVE #${moveIndex + 1}`
      : "ORBIT MODE";
    tag.style.color = (addMode || moveIndex >= 0) ? "var(--red)" : "";
  }
}

// ---------- model loading (mirrors features.js) ----------
function loadModel() {
  const f = cfg();
  const url = f.modelPath || "/3dfiles/bomb_full.obj";
  const color = new THREE.Color(f.wireframeColor || "#f5b32a");
  const triMat = new THREE.MeshBasicMaterial({
    color, wireframe: true, transparent: true, opacity: 0.18, depthWrite: false,
  });
  const edgeMat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.95 });

  return new Promise((resolve) => {
    new OBJLoader().load(
      url,
      (obj) => {
        if (!mounted) return resolve();
        const root = new THREE.Group();
        const colliderHolder = new THREE.Group();
        obj.traverse((child) => {
          if (child.isMesh) {
            const wireMesh = new THREE.Mesh(child.geometry, triMat);
            wireMesh.position.copy(child.position);
            wireMesh.rotation.copy(child.rotation);
            wireMesh.scale.copy(child.scale);
            root.add(wireMesh);

            const edges = new THREE.LineSegments(new THREE.EdgesGeometry(child.geometry, 12), edgeMat);
            edges.position.copy(child.position);
            edges.rotation.copy(child.rotation);
            edges.scale.copy(child.scale);
            root.add(edges);

            const colMesh = new THREE.Mesh(child.geometry, new THREE.MeshBasicMaterial({ visible: false }));
            colMesh.position.copy(child.position);
            colMesh.rotation.copy(child.rotation);
            colMesh.scale.copy(child.scale);
            colliderHolder.add(colMesh);
          }
        });
        root.add(colliderHolder);

        const box = new THREE.Box3().setFromObject(root);
        const size = box.getSize(new THREE.Vector3()).length() || 1;
        const center = box.getCenter(new THREE.Vector3());
        root.position.copy(center).multiplyScalar(-1);
        const s = 2.2 / size;
        const outer = new THREE.Group();
        outer.add(root);
        outer.scale.setScalar(s);
        outer.rotation.y = degToRad(f?.frontYawDeg);
        scene.add(outer);
        model = outer;
        collider = colliderHolder;
        modelOriginalCenter.copy(center);
        modelScale = s;
        resolve();
      },
      undefined,
      () => {
        api.toast("MODEL FAILED TO LOAD", "err");
        resolve();
      }
    );
  });
}

// ---------- coordinates ----------
// Convert a world-space surface hit into OBJ-space coords (modelPosition).
function worldToObjSpace(worldPoint) {
  const local = model.worldToLocal(worldPoint.clone()); // outer-local == OBJ coords minus center
  return local.add(modelOriginalCenter);
}
// OBJ-space -> outer-local (for placing markers).
function objSpaceToOuterLocal(v3) {
  return new THREE.Vector3(...v3).sub(modelOriginalCenter);
}

// Resolve any config point (modelPosition / position / section / direction)
// into outer-local coords, same rules as the player viewer.
function resolvePoint(p) {
  if (Array.isArray(p.modelPosition)) return objSpaceToOuterLocal(p.modelPosition);
  if (Array.isArray(p.position)) return model.worldToLocal(new THREE.Vector3(...p.position));
  if (p.section) {
    const sec = api.getDraft().blueprint?.sections?.find((s) => s.code === p.section);
    return raycastFromDirection(new THREE.Vector3(...(sec?.offset || [0, 1, 0])));
  }
  if (Array.isArray(p.direction)) return raycastFromDirection(new THREE.Vector3(...p.direction));
  return null;
}

function raycastFromDirection(dir) {
  if (!collider || dir.lengthSq() < 1e-6) return null;
  dir = dir.clone().normalize();
  const rc = new THREE.Raycaster(dir.clone().multiplyScalar(8), dir.clone().multiplyScalar(-1), 0, 20);
  const hits = rc.intersectObject(collider, true);
  if (!hits.length) return null;
  return model.worldToLocal(hits[0].point.clone());
}

// ---------- markers ----------
function rebuildMarkers() {
  if (!model) return;
  if (markerHost) {
    model.remove(markerHost);
    markerHost.traverse((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); o.material?.map?.dispose?.(); });
  }
  markerHost = new THREE.Group();
  markerHost.scale.setScalar(1 / modelScale);
  model.add(markerHost);
  model.updateMatrixWorld(true);

  const color = new THREE.Color(cfg().highlightColor || "#ff2a3a");
  const selColor = new THREE.Color("#7ad7ff");

  points().forEach((p, i) => {
    const local = resolvePoint(p);
    if (!local) return;
    const pos = local.clone().multiplyScalar(modelScale); // -> markerHost units (world scale)
    const c = i === selectedIndex ? selColor : color;

    const ball = new THREE.Mesh(
      new THREE.SphereGeometry(0.05, 18, 14),
      new THREE.MeshBasicMaterial({ color: c, depthTest: false })
    );
    ball.position.copy(pos);
    ball.renderOrder = 20;
    ball.userData.pointIndex = i;
    markerHost.add(ball);

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.09, 0.13, 36),
      new THREE.MeshBasicMaterial({ color: c, side: THREE.DoubleSide, transparent: true, opacity: 0.9, depthTest: false })
    );
    ring.position.copy(pos);
    ring.userData.faceCamera = true;
    ring.renderOrder = 19;
    markerHost.add(ring);

    const sp = makeLabelSprite(p.label || `PORT ${i + 1}`, c);
    sp.position.copy(pos.clone().add(pos.clone().normalize().multiplyScalar(0.42)));
    sp.scale.set(0.55, 0.22, 1);
    sp.renderOrder = 21;
    markerHost.add(sp);
  });
}

function makeLabelSprite(text, color) {
  const w = 256, h = 96;
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "rgba(5,6,7,0.9)";
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = "#" + color.getHexString();
  ctx.lineWidth = 3;
  ctx.strokeRect(2, 2, w - 4, h - 4);
  ctx.fillStyle = "#" + color.getHexString();
  ctx.font = "bold 44px JetBrains Mono, Consolas, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(String(text).toUpperCase(), w / 2, h / 2 + 2);
  const tex = new THREE.CanvasTexture(c);
  tex.minFilter = THREE.LinearFilter;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  return new THREE.Sprite(mat);
}

// ---------- input ----------
function onPointerDown(e) {
  pointerDownInfo = { x: e.clientX, y: e.clientY, t: performance.now() };
}

function onPointerUp(e) {
  if (!pointerDownInfo) return;
  const dx = e.clientX - pointerDownInfo.x;
  const dy = e.clientY - pointerDownInfo.y;
  const isClick = Math.hypot(dx, dy) < 8 && performance.now() - pointerDownInfo.t < 600;
  pointerDownInfo = null;
  if (!isClick || !model) return;

  const rect = renderer.domElement.getBoundingClientRect();
  pointerVec.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  pointerVec.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointerVec, camera);

  if (addMode || moveIndex >= 0) {
    const hits = collider ? raycaster.intersectObject(collider, true) : [];
    if (!hits.length) { api.toast("NO SURFACE HIT — TAP THE MODEL", "err"); return; }
    const obj = worldToObjSpace(hits[0].point);
    const rounded = [obj.x, obj.y, obj.z].map((v) => Math.round(v * 1000) / 1000);
    if (moveIndex >= 0) {
      const p = points()[moveIndex];
      delete p.section; delete p.direction; delete p.position;
      p.modelPosition = rounded;
      selectedIndex = moveIndex;
      moveIndex = -1;
      api.toast("POINT MOVED", "ok");
    } else {
      points().push({ label: `PORT ${String.fromCharCode(65 + (points().length % 26))}`, modelPosition: rounded });
      selectedIndex = points().length - 1;
      api.toast("POINT ADDED — LABEL IT BELOW", "ok");
    }
    api.markDirty();
    rebuildMarkers();
    renderList();
    updateModeUi();
    return;
  }

  // plain click: try selecting a marker ball
  const balls = [];
  markerHost?.traverse((o) => { if (o.userData?.pointIndex !== undefined) balls.push(o); });
  const hits = raycaster.intersectObjects(balls, false);
  if (hits.length) {
    selectedIndex = hits[0].object.userData.pointIndex;
    rebuildMarkers();
    renderList();
  }
}

// ---------- list ----------
function renderList() {
  const el = document.getElementById("pt-list");
  if (!el) return;
  const pts = points();
  if (!pts.length) {
    el.innerHTML = `<div class="empty">NO POINTS YET — USE "ADD POINT" AND TAP THE MODEL</div>`;
    return;
  }
  el.innerHTML = pts.map((p, i) => {
    const kind = Array.isArray(p.modelPosition) ? "FIXED"
      : Array.isArray(p.position) ? "SCENE"
      : p.section ? `SECTION ${api.escapeHtml(p.section)}`
      : Array.isArray(p.direction) ? "DIRECTION" : "UNSET";
    const coords = Array.isArray(p.modelPosition) ? p.modelPosition.map((v) => v.toFixed?.(1) ?? v).join(", ") : "—";
    return `
      <div class="row-item pt-row ${i === selectedIndex ? "selected" : ""}" data-i="${i}">
        <input type="text" value="${api.escapeHtml(p.label || "")}" data-f="label" placeholder="LABEL" />
        <span class="badge ${Array.isArray(p.modelPosition) ? "pos" : ""}">${kind}</span>
        <span class="coords">${coords}</span>
        <button class="btn small ${i === moveIndex ? "primary" : ""}" data-act="move">${i === moveIndex ? "TAP MODEL…" : "MOVE"}</button>
        <button class="btn small danger" data-act="del">✕</button>
      </div>`;
  }).join("");

  for (const row of el.querySelectorAll(".pt-row")) {
    const i = Number(row.dataset.i);
    row.addEventListener("click", (e) => {
      if (e.target.closest("button") || e.target.tagName === "INPUT") return;
      selectedIndex = i;
      rebuildMarkers();
      renderList();
    });
    row.querySelector("[data-f='label']").addEventListener("input", (e) => {
      points()[i].label = e.target.value;
      api.markDirty();
      rebuildMarkers();
    });
    row.querySelector("[data-act='move']").addEventListener("click", () => {
      moveIndex = moveIndex === i ? -1 : i;
      addMode = false;
      updateModeUi();
      renderList();
    });
    row.querySelector("[data-act='del']").addEventListener("click", () => {
      points().splice(i, 1);
      if (selectedIndex === i) selectedIndex = -1;
      if (moveIndex === i) moveIndex = -1;
      api.markDirty();
      rebuildMarkers();
      renderList();
    });
  }
}

// ---------- render loop ----------
function loop() {
  if (!mounted) return;
  raf = requestAnimationFrame(loop);
  glide?.step();
  if (model) {
    model.updateMatrixWorld(true);
    if (markerHost) {
      const inv = new THREE.Matrix4().copy(markerHost.matrixWorld).invert();
      const camInHost = camera.getWorldPosition(new THREE.Vector3()).applyMatrix4(inv);
      markerHost.traverse((o) => { if (o.userData?.faceCamera) o.lookAt(camInHost); });
    }
  }
  controls.update();
  updateFacing();
  renderer.render(scene, camera);
}
