// Features — wireframe viewer with lock-pick markers projected onto the bomb surface.
//
// Marker positioning (in puzzles.json under features.lockPickPoints):
//   { "label": "PORT A", "section": "FTR" }
//     → cast a ray from outside the FTR octant toward the bomb's center;
//       drop the marker on the first surface hit.
//   { "label": "PORT B", "direction": [1, 0.4, 0.8] }
//     → same idea but with an arbitrary direction vector.
//   { "label": "PORT C", "modelPosition": [x, y, z] }
//     → use raw OBJ-space coordinates (transformed by centering+scaling).
//   { "label": "PORT D", "position": [x, y, z] }
//     → use scene-space coordinates directly (range roughly -1.1 to 1.1).
//
// All markers are children of the model group, so they rotate with the
// model and never drift off the surface.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { state, showScreen, escapeHtml } from "/js/app.js";
import {
  viewPosition, facingLabel, degToRad, makeCameraGlide, buildViewBar, markActiveView,
} from "/js/viewer/viewutils.js";

let scene, camera, renderer, controls, container, raf;
let model = null;        // group containing wireframe + invisible collider
let collider = null;     // invisible mesh used for raycasting
let modelOriginalCenter = new THREE.Vector3();
let modelScale = 1;
let glide = null;

export function initFeatures() {
  document.getElementById("f-back").addEventListener("click", () => {
    stop();
    showScreen("main");
  });
}

export async function openFeatures() {
  showScreen("features");
  await mount();
  renderPortList();
}

async function mount() {
  container = document.getElementById("f-viewer");
  for (const c of container.querySelectorAll("canvas")) c.remove();
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
  controls.enablePan = false;
  controls.minDistance = 1.5;
  controls.maxDistance = 9;
  controls.autoRotate = state.config?.features?.autoRotate !== false;
  controls.autoRotateSpeed = 0.9;
  glide = makeCameraGlide(camera, controls);

  scene.add(new THREE.AmbientLight(0xffffff, 0.6));

  await loadModel();
  addPorts();
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
  if (model) {
    scene?.remove(model);
    model.traverse((o) => {
      o.geometry?.dispose?.();
      o.material?.dispose?.();
    });
    model = null;
    collider = null;
    markerHost = null;
  }
}

function onResize() {
  if (!container || !renderer) return;
  const w = container.clientWidth, h = container.clientHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

async function loadModel() {
  const cfg = state.config?.features;
  const url = cfg?.modelPath || "/3dfiles/bomb_full.obj";
  const color = new THREE.Color(cfg?.wireframeColor || "#f5b32a");
  // Two-pass wireframe: a faint full-triangle mesh for "tactical" density,
  // plus crisp silhouette edges on top so the form reads clearly.
  const triMat = new THREE.MeshBasicMaterial({
    color, wireframe: true, transparent: true, opacity: 0.18, depthWrite: false,
  });
  const edgeMat = new THREE.LineBasicMaterial({
    color, transparent: true, opacity: 0.95,
  });

  return new Promise((resolve) => {
    new OBJLoader().load(
      url,
      (obj) => {
        const root = new THREE.Group();
        const colliderHolder = new THREE.Group();
        colliderHolder.userData.isCollider = true;

        obj.traverse((child) => {
          if (child.isMesh) {
            // Faint dense wireframe
            const wireMesh = new THREE.Mesh(child.geometry, triMat);
            wireMesh.position.copy(child.position);
            wireMesh.rotation.copy(child.rotation);
            wireMesh.scale.copy(child.scale);
            root.add(wireMesh);

            // Sharp edges on top
            const edges = new THREE.LineSegments(
              new THREE.EdgesGeometry(child.geometry, 12),
              edgeMat,
            );
            edges.position.copy(child.position);
            edges.rotation.copy(child.rotation);
            edges.scale.copy(child.scale);
            root.add(edges);

            // Invisible mesh for raycasting only.
            const colMesh = new THREE.Mesh(
              child.geometry,
              new THREE.MeshBasicMaterial({ visible: false })
            );
            colMesh.position.copy(child.position);
            colMesh.rotation.copy(child.rotation);
            colMesh.scale.copy(child.scale);
            colliderHolder.add(colMesh);
          }
        });
        root.add(colliderHolder);

        // Center & scale
        const box = new THREE.Box3().setFromObject(root);
        const size = box.getSize(new THREE.Vector3()).length() || 1;
        const center = box.getCenter(new THREE.Vector3());
        root.position.copy(center).multiplyScalar(-1);
        const s = 2.2 / size;
        // Wrap in outer group so we can scale around origin without touching root.position semantics.
        const outer = new THREE.Group();
        outer.add(root);
        outer.scale.setScalar(s);
        // Turn the raw scan so the prop's true front faces world +Z. Applied
        // before ports are placed so section-based markers land on the right side.
        outer.rotation.y = degToRad(cfg?.frontYawDeg);
        scene.add(outer);
        model = outer;
        collider = colliderHolder;
        modelOriginalCenter.copy(center);
        modelScale = s;
        resolve();
      },
      undefined,
      () => {
        // Fallback box
        const fbGroup = new THREE.Group();
        const box = new THREE.LineSegments(
          new THREE.EdgesGeometry(new THREE.BoxGeometry(2, 2, 2)),
          new THREE.LineBasicMaterial({ color })
        );
        fbGroup.add(box);
        scene.add(fbGroup);
        model = fbGroup;
        collider = null;
        resolve();
      }
    );
  });
}

let markerHost = null;

function addPorts() {
  const cfg = state.config?.features;
  const color = new THREE.Color(cfg?.highlightColor || "#ff2a3a");
  if (!model) return;
  model.updateMatrixWorld(true);

  // Markers live inside an inverse-scaled group so we can size them in world
  // units — model is scaled by `modelScale` (~0.0018), which would otherwise
  // shrink any local-unit geometry into invisibility.
  markerHost = new THREE.Group();
  markerHost.scale.setScalar(1 / modelScale);
  model.add(markerHost);

  for (const p of cfg?.lockPickPoints || []) {
    const localPos = resolveMarkerPosition(p);
    if (!localPos) {
      console.warn("[features] could not resolve marker position", p);
      continue;
    }
    // Convert from model-local to markerHost-local (markerHost has 1/modelScale).
    addMarker(localPos.clone().multiplyScalar(modelScale), color, p.label);
  }
}

// Resolve a config entry into a position in MODEL-LOCAL coords.
// Markers will be added as children of `model`, which is the outer scaled group.
function resolveMarkerPosition(p) {
  // 1. explicit scene-space coord
  if (Array.isArray(p.position)) {
    // p.position is in world/scene coords; convert to model-local
    const world = new THREE.Vector3(...p.position);
    return model.worldToLocal(world.clone());
  }
  // 2. raw model coords (OBJ space). Need to apply centering done at load.
  if (Array.isArray(p.modelPosition)) {
    const v = new THREE.Vector3(...p.modelPosition).sub(modelOriginalCenter);
    // root inside outer has position = -center applied already, so v in world before outer.scale = v.
    // outer.scale is uniform; converting to model-local of outer: v / scale.
    // But since outer's children include root, and root's position was -center, geometry vertex V
    // appears at world (V - center) * outer.scale. The marker will be a child of outer (model).
    // We want marker world = (modelPosition - center) * outer.scale, so marker.localInOuter * outer.scale = (mP - center) * outer.scale → local = mP - center.
    return v;
  }
  // 3. by section name → raycast from that direction onto the surface
  if (p.section) {
    const sectionConfig = state.config?.blueprint?.sections?.find((s) => s.code === p.section);
    const off = sectionConfig?.offset || [0, 1, 0];
    const dir = new THREE.Vector3(...off);
    return raycastToSurface(dir);
  }
  // 4. arbitrary direction → raycast
  if (Array.isArray(p.direction)) {
    return raycastToSurface(new THREE.Vector3(...p.direction));
  }
  return null;
}

function raycastToSurface(directionVec) {
  if (!collider) return null;
  if (directionVec.lengthSq() < 1e-6) return new THREE.Vector3();
  directionVec = directionVec.clone().normalize();
  // Start far outside the model along direction, fire toward origin (model center).
  const start = directionVec.clone().multiplyScalar(8);
  const into = directionVec.clone().multiplyScalar(-1);
  const raycaster = new THREE.Raycaster(start, into, 0, 20);
  const hits = raycaster.intersectObject(collider, true);
  if (!hits.length) return null;
  // Convert world hit to model-local (model = outer group)
  return model.worldToLocal(hits[0].point.clone());
}

function addMarker(worldPos, color, label) {
  // worldPos is in markerHost-local, which equals world units (host has scale=1/modelScale).
  // Sphere at the surface
  const ball = new THREE.Mesh(
    new THREE.SphereGeometry(0.05, 18, 14),
    new THREE.MeshBasicMaterial({ color, depthTest: false })
  );
  ball.position.copy(worldPos);
  ball.renderOrder = 20;
  markerHost.add(ball);

  // Bright ring (faces camera)
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.09, 0.13, 36),
    new THREE.MeshBasicMaterial({
      color, side: THREE.DoubleSide, transparent: true, opacity: 0.9, depthTest: false,
    })
  );
  ring.position.copy(worldPos);
  ring.userData.faceCamera = true;
  ring.userData.pulse = true;
  ring.renderOrder = 19;
  markerHost.add(ring);

  // Halo (slow pulse)
  const halo = new THREE.Mesh(
    new THREE.RingGeometry(0.16, 0.20, 36),
    new THREE.MeshBasicMaterial({
      color, side: THREE.DoubleSide, transparent: true, opacity: 0.45, depthTest: false,
    })
  );
  halo.position.copy(worldPos);
  halo.userData.faceCamera = true;
  halo.userData.pulseSlow = true;
  halo.renderOrder = 18;
  markerHost.add(halo);

  // Crosshair (gap in middle)
  const crossMat = new THREE.LineBasicMaterial({
    color, transparent: true, opacity: 0.9, depthTest: false,
  });
  const crossGeo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-0.30, 0, 0), new THREE.Vector3(-0.10, 0, 0),
    new THREE.Vector3(0.10, 0, 0), new THREE.Vector3(0.30, 0, 0),
    new THREE.Vector3(0, -0.30, 0), new THREE.Vector3(0, -0.10, 0),
    new THREE.Vector3(0, 0.10, 0), new THREE.Vector3(0, 0.30, 0),
  ]);
  const cross = new THREE.LineSegments(crossGeo, crossMat);
  cross.position.copy(worldPos);
  cross.userData.faceCamera = true;
  cross.renderOrder = 17;
  markerHost.add(cross);

  // Leader line outward from surface
  const dir = worldPos.clone().normalize();
  const end = worldPos.clone().add(dir.multiplyScalar(0.5));
  const leaderGeo = new THREE.BufferGeometry().setFromPoints([worldPos.clone(), end]);
  const leader = new THREE.Line(leaderGeo, new THREE.LineBasicMaterial({
    color, transparent: true, opacity: 0.75, depthTest: false,
  }));
  leader.renderOrder = 16;
  markerHost.add(leader);

  if (label) {
    const sp = makeMarkerLabel(label, color);
    sp.position.copy(end);
    sp.renderOrder = 21;
    sp.scale.set(0.55, 0.22, 1); // world units
    markerHost.add(sp);
  }
}

function makeMarkerLabel(text, color) {
  const w = 256, h = 96;
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d");
  ctx.clearRect(0, 0, w, h);
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
  tex.magFilter = THREE.LinearFilter;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  return new THREE.Sprite(mat);
}

function loop() {
  raf = requestAnimationFrame(loop);
  if (model) {
    glide?.step();
    model.updateMatrixWorld(true);

    // For markers parented to markerHost (which has its own scale + parent transforms),
    // billboard-orient them by converting camera world position into the marker's parent space.
    const tNow = performance.now();
    if (markerHost) {
      const inv = new THREE.Matrix4().copy(markerHost.matrixWorld).invert();
      const camInHost = camera.getWorldPosition(new THREE.Vector3()).applyMatrix4(inv);
      markerHost.traverse((o) => {
        if (o.userData?.faceCamera) o.lookAt(camInHost);
        if (o.userData?.pulse) {
          const s = 1 + 0.18 * Math.sin(tNow * 0.005);
          o.scale.setScalar(s);
        }
        if (o.userData?.pulseSlow) {
          const s = 1 + 0.30 * Math.sin(tNow * 0.0025 + 1.2);
          o.scale.setScalar(s);
        }
      });
    }
  }
  controls.update();
  updateFacing();
  renderer.render(scene, camera);
}

// ---------- view controls ----------
function initViewBar() {
  const bar = document.getElementById("f-views");
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
  const el = document.getElementById("f-facing");
  if (!el) return;
  const label = facingLabel(camera);
  if (label === lastFacing) return;
  lastFacing = label;
  el.textContent = "VIEW · " + label;
  el.classList.toggle("front", label === "FRONT");
  markActiveView(document.getElementById("f-views"), label.toLowerCase());
}

function renderPortList() {
  const cfg = state.config?.features;
  const list = document.getElementById("f-port-list");
  list.innerHTML = "";
  for (const p of cfg?.lockPickPoints || []) {
    const div = document.createElement("div");
    div.className = "panel thin";
    div.style.marginBottom = "6px";
    const where = p.section ? `SECTION ${p.section}` : (p.modelPosition ? "MODEL" : (p.position ? "SCENE" : "DIR"));
    div.innerHTML = `
      <div class="flex between">
        <span class="mono red">⬤ ${escapeHtml(p.label)}</span>
        <span class="mono dim">${escapeHtml(where)}</span>
      </div>`;
    list.appendChild(div);
  }
}
