// Shared camera-orientation helpers for the 3D viewers.
//
// The bomb sits in a FIXED orientation (its configured `frontYawDeg` turns the
// raw scan so the prop's real front faces world +Z). The camera is what moves —
// idle spin uses OrbitControls' own autoRotate rather than turning the model,
// so "front" always means the same face and the view presets below are exact.
//
// Axis convention, matching blueprint section offsets (FTR = [1, 1, 1]):
//   +Z front · -Z back · +X right · -X left · +Y top

import * as THREE from "three";

export const VIEW_NAMES = ["front", "back", "left", "right", "top"];

const DIRS = {
  front: [0, 0, 1],
  back: [0, 0, -1],
  left: [-1, 0, 0],
  right: [1, 0, 0],
  top: [0, 1, 0.0015],      // nudge off the pole so `up` stays well defined
  bottom: [0, -1, 0.0015],
};

// Where the camera should sit for a named view, keeping the current zoom.
export function viewPosition(name, distance) {
  const d = DIRS[name] || DIRS.front;
  const len = Math.hypot(d[0], d[1], d[2]) || 1;
  return [(d[0] / len) * distance, (d[1] / len) * distance, (d[2] / len) * distance];
}

// Which side of the object the camera is currently looking at.
export function facingLabel(camera) {
  const p = camera.position;
  const flat = Math.hypot(p.x, p.z);
  const elevation = (Math.atan2(p.y, flat) * 180) / Math.PI;
  if (elevation > 62) return "TOP";
  if (elevation < -62) return "BOTTOM";
  const az = (((Math.atan2(p.x, p.z) * 180) / Math.PI) % 360 + 360) % 360;
  return [
    "FRONT", "FRONT-RIGHT", "RIGHT", "BACK-RIGHT",
    "BACK", "BACK-LEFT", "LEFT", "FRONT-LEFT",
  ][Math.round(az / 45) % 8];
}

// Camera heading in degrees, 0 = looking at the front face.
export function cameraAzimuthDeg(camera) {
  const p = camera.position;
  return (((Math.atan2(p.x, p.z) * 180) / Math.PI) % 360 + 360) % 360;
}

export function degToRad(d) { return (Number(d) || 0) * Math.PI / 180; }

// Swings the camera to a view over a few frames so players keep their
// bearings. Interpolation runs in SPHERICAL space: a straight line from
// FRONT to BACK would pass through the middle of the model and slam into
// the minDistance clamp. Call step() from the render loop.
export function makeCameraGlide(camera, controls) {
  const from = new THREE.Spherical();
  const goal = new THREE.Spherical();
  const tmp = new THREE.Vector3();
  let active = false;

  const place = (sph) => {
    camera.position.setFromSpherical(sph).add(controls.target);
    camera.lookAt(controls.target);
  };

  return {
    toView(name) {
      const radius = camera.position.distanceTo(controls.target) || 4.5;
      const p = viewPosition(name, radius);
      goal.setFromVector3(tmp.set(p[0], p[1], p[2]));
      goal.makeSafe();
      active = true;
      controls.autoRotate = false;
    },
    cancel() { active = false; },
    step() {
      if (!active) return;
      from.setFromVector3(tmp.copy(camera.position).sub(controls.target));

      let dTheta = goal.theta - from.theta;
      while (dTheta > Math.PI) dTheta -= Math.PI * 2;
      while (dTheta < -Math.PI) dTheta += Math.PI * 2;
      const dPhi = goal.phi - from.phi;
      const dR = goal.radius - from.radius;

      if (Math.abs(dTheta) < 0.005 && Math.abs(dPhi) < 0.005 && Math.abs(dR) < 0.01) {
        place(goal);
        active = false;
        return;
      }
      const k = 0.18;
      from.theta += dTheta * k;
      from.phi += dPhi * k;
      from.radius += dR * k;
      from.makeSafe();
      place(from);
    },
  };
}

// Builds the FRONT / BACK / LEFT / RIGHT / TOP + SPIN button row.
export function buildViewBar(container, { onView, onSpin, spinning }) {
  container.innerHTML = VIEW_NAMES
    .map((v) => `<button data-view="${v}">${v.toUpperCase()}</button>`)
    .join("") + `<button data-view="spin" class="spin${spinning ? " on" : ""}">SPIN</button>`;
  for (const btn of container.querySelectorAll("button")) {
    btn.addEventListener("click", () => {
      const v = btn.dataset.view;
      if (v === "spin") {
        const on = !btn.classList.contains("on");
        btn.classList.toggle("on", on);
        onSpin(on);
        return;
      }
      container.querySelector(".spin")?.classList.remove("on");
      for (const b of container.querySelectorAll("button")) b.classList.toggle("sel", b === btn);
      onView(v);
    });
  }
}

export function markActiveView(container, name) {
  for (const b of container.querySelectorAll("button")) {
    if (b.dataset.view !== "spin") b.classList.toggle("sel", b.dataset.view === name);
  }
}
