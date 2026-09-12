// Blueprint — exploded wireframe of the 8 sections.
// Each whole_*.obj contains its octant's geometry at its true world-space
// position. We:
//   1. Build a `sectionGroup` per section (lines only, geometry untouched).
//   2. Compute the combined bounding box → center + scale.
//   3. Put all sectionGroups inside a single `assembly` group whose
//      transform handles centering and scaling. From then on, each
//      sectionGroup.position is purely its explode offset.
//   4. For each section, derive its outward direction from its own bbox
//      center (vs. the global center). This gives accurate explode vectors
//      and a stable home for the numbered label.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { state, showScreen, escapeHtml } from "/js/app.js";
import {
  viewPosition, facingLabel, degToRad, makeCameraGlide, buildViewBar, markActiveView,
} from "/js/viewer/viewutils.js";

let scene, camera, renderer, controls, container, raf;
let group = null;       // top-level rotator
let assembly = null;    // child of group; holds centering+scale
let sectionGroups = []; // children of assembly
let explodeT = 0;
let normSize = 1;
let glide = null;       // bomb size in world units after centering

export function initBlueprint() {
  document.getElementById("bp-back").addEventListener("click", () => {
    stop();
    showScreen("main");
  });
}

export async function openBlueprint() {
  showScreen("blueprint");
  await mount();
  renderSectionList();
}

async function mount() {
  container = document.getElementById("bp-viewer");
  for (const c of container.querySelectorAll("canvas")) c.remove();
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
  controls.autoRotate = state.config?.blueprint?.autoRotate !== false;
  controls.autoRotateSpeed = 0.8;
  glide = makeCameraGlide(camera, controls);

  scene.add(new THREE.AmbientLight(0xffffff, 0.7));

  await loadSections();
  initViewBar();

  window.addEventListener("resize", onResize);
  loop();
}

function stop() {
  cancelAnimationFrame(raf);
  raf = null;
  window.removeEventListener("resize", onResize);
  if (renderer) {
    renderer.dispose();
    renderer.domElement?.remove?.();
  }
  if (group) {
    scene?.remove(group);
    group.traverse((o) => {
      o.geometry?.dispose?.();
      o.material?.dispose?.();
      o.material?.map?.dispose?.();
    });
    group = null;
  }
  assembly = null;
  sectionGroups = [];
  explodeT = 0;
}

function onResize() {
  if (!container || !renderer) return;
  const w = container.clientWidth, h = container.clientHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

async function loadSections() {
  const cfg = state.config?.blueprint;
  const sections = cfg?.sections || [];
  const color = new THREE.Color(cfg?.wireframeColor || "#7ad7ff");
  const explodeFactor = cfg?.explodeFactor ?? 1.6;

  group = new THREE.Group();
  group.rotation.y = degToRad(cfg?.frontYawDeg);
  scene.add(group);
  assembly = new THREE.Group();
  group.add(assembly);

  const loader = new OBJLoader();
  const loaded = await Promise.all(sections.map((s) =>
    new Promise((resolve) => {
      loader.load(s.model, (obj) => resolve({ s, obj }), undefined, () => resolve({ s, obj: null }));
    })
  ));

  // Build section groups using wireframe-shaded meshes (every triangle edge).
  sectionGroups = [];
  const wireMat = new THREE.MeshBasicMaterial({
    color, wireframe: true, transparent: true, opacity: 0.75,
  });
  for (const { s, obj } of loaded) {
    const sg = new THREE.Group();
    sg.userData.section = s;
    if (obj) {
      obj.traverse((child) => {
        if (child.isMesh) {
          sg.add(new THREE.Mesh(child.geometry, wireMat));
        }
      });
    } else {
      // fallback box at the section's offset position
      const fallback = new THREE.Mesh(
        new THREE.BoxGeometry(0.6, 0.6, 0.6),
        new THREE.MeshBasicMaterial({ color, wireframe: true })
      );
      const off = s.offset || [0, 0, 0];
      fallback.position.set(off[0] * 0.5, off[1] * 0.5, off[2] * 0.5);
      sg.add(fallback);
    }
    assembly.add(sg);
    sectionGroups.push(sg);
  }

  // Compute combined bounding box from each section's geometry (in world coords).
  const combined = new THREE.Box3();
  for (const sg of sectionGroups) {
    const sbox = new THREE.Box3().setFromObject(sg);
    sg.userData.localBox = sbox;
    if (!sbox.isEmpty()) combined.union(sbox);
  }
  if (combined.isEmpty()) combined.set(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));

  const center = combined.getCenter(new THREE.Vector3());
  const sizeVec = combined.getSize(new THREE.Vector3());
  const sizeLen = sizeVec.length() || 1;
  const scale = 3.2 / sizeLen;
  normSize = sizeLen;

  // Apply assembly centering+scaling. Child sections (sectionGroup.position=0)
  // now sit in their assembled positions; sg.position is reserved for explode.
  assembly.position.copy(center).multiplyScalar(-scale);
  assembly.scale.setScalar(scale);

  // Per-section data + label sprite
  for (const sg of sectionGroups) {
    const localBox = sg.userData.localBox;
    let sectionCenter, direction;
    if (!localBox.isEmpty()) {
      sectionCenter = localBox.getCenter(new THREE.Vector3());
      direction = sectionCenter.clone().sub(center);
    } else {
      const off = sg.userData.section.offset || [0, 0, 0];
      direction = new THREE.Vector3(...off);
      if (direction.length() > 0) direction.normalize().multiplyScalar(sizeLen / 4);
      sectionCenter = center.clone().add(direction);
    }
    sg.userData.direction = direction;          // displacement vector for explode (pre-scale units)
    sg.userData.explodeFactor = explodeFactor;

    // Label sprite — child of section so it travels with the explode.
    const sprite = makeLabel(String(sg.userData.section.id), sg.userData.section.code, color);
    // Place at section center, pulled outward 18% of bomb size for clearance.
    sprite.position.copy(sectionCenter);
    if (direction.length() > 0.001) {
      sprite.position.add(direction.clone().normalize().multiplyScalar(sizeLen * 0.18));
    }
    // Sprite scale is in pre-scale units (assembly will scale by `scale`).
    // Target world size ~0.55, so local scale = 0.55/scale.
    const target = 0.55 / scale;
    sprite.scale.set(target, target * 0.55, 1); // wider than tall
    sg.add(sprite);
  }
}

function makeLabel(idText, codeText, color) {
  const w = 256, h = 140;
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d");
  ctx.clearRect(0, 0, w, h);
  // background
  ctx.fillStyle = "rgba(5, 6, 7, 0.92)";
  ctx.fillRect(0, 0, w, h);
  // amber border
  ctx.strokeStyle = "#" + color.getHexString();
  ctx.lineWidth = 4;
  ctx.strokeRect(2, 2, w - 4, h - 4);
  // corner ticks
  ctx.lineWidth = 3;
  const tick = 16;
  ctx.beginPath();
  ctx.moveTo(2, 2 + tick); ctx.lineTo(2, 2); ctx.lineTo(2 + tick, 2);
  ctx.moveTo(w - 2 - tick, 2); ctx.lineTo(w - 2, 2); ctx.lineTo(w - 2, 2 + tick);
  ctx.moveTo(2, h - 2 - tick); ctx.lineTo(2, h - 2); ctx.lineTo(2 + tick, h - 2);
  ctx.moveTo(w - 2 - tick, h - 2); ctx.lineTo(w - 2, h - 2); ctx.lineTo(w - 2, h - 2 - tick);
  ctx.stroke();
  // ID number
  ctx.fillStyle = "#" + color.getHexString();
  ctx.font = "bold 80px JetBrains Mono, Consolas, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(idText, w / 2, 60);
  // code label below
  ctx.font = "bold 22px JetBrains Mono, Consolas, monospace";
  ctx.fillStyle = "#cccccc";
  ctx.fillText(codeText || "", w / 2, 116);

  const tex = new THREE.CanvasTexture(c);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  const sp = new THREE.Sprite(mat);
  sp.renderOrder = 999;
  return sp;
}

function loop() {
  raf = requestAnimationFrame(loop);
  if (explodeT < 1) explodeT = Math.min(1, explodeT + 0.012);
  glide?.step();
  if (assembly) {
    for (const sg of sectionGroups) {
      if (sg.userData?.direction) {
        const factor = ease(explodeT) * (sg.userData.explodeFactor - 1);
        sg.position.copy(sg.userData.direction).multiplyScalar(factor);
      }
    }
  }
  controls.update();
  updateFacing();
  renderer.render(scene, camera);
}

// ---------- view controls ----------
function initViewBar() {
  const bar = document.getElementById("bp-views");
  if (!bar) return;
  buildViewBar(bar, {
    spinning: controls.autoRotate,
    onView: (name) => glide.toView(name),
    onSpin: (on) => { controls.autoRotate = on; if (on) glide.cancel(); },
  });
  markActiveView(bar, "front");
}

let lastFacing = "";
function updateFacing() {
  const el = document.getElementById("bp-facing");
  if (!el) return;
  const label = facingLabel(camera);
  if (label === lastFacing) return;
  lastFacing = label;
  el.textContent = "VIEW · " + label;
  el.classList.toggle("front", label === "FRONT");
  markActiveView(document.getElementById("bp-views"), label.toLowerCase());
}

function ease(t) { return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t; }

function renderSectionList() {
  const list = document.getElementById("bp-sections");
  const cfg = state.config?.blueprint;
  list.innerHTML = "";
  for (const s of cfg?.sections || []) {
    const div = document.createElement("div");
    div.className = "s";
    div.innerHTML = `<span class="id">${s.id}</span><span class="nm">${escapeHtml(s.code)} · ${escapeHtml(s.name)}</span>`;
    list.appendChild(div);
  }
}
