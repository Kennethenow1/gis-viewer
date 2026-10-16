// The "shot" places the globe + stand on screen. Like the appearance panel it is preview-only:
// every page load starts from defaultShot.
const defaultShot = { x: 0, y: 9, rotX: 0, rotY: 0, rotZ: 0, longitude: 30.1, tilt: 13.2, zoom: 6.1 };

const shotFields = [
  { section: "Object (globe + holder)" },
  { key: "x", label: "Location X", min: -100, max: 100, step: 0.5 },
  { key: "y", label: "Location Y", min: -100, max: 100, step: 0.5 },
  { key: "rotX", label: "Rotation X", min: -180, max: 180, step: 0.5 },
  { key: "rotY", label: "Rotation Y", min: -180, max: 180, step: 0.5 },
  { key: "rotZ", label: "Rotation Z", min: -180, max: 180, step: 0.5 },
  { section: "Globe" },
  { key: "longitude", label: "Spin", min: -180, max: 180, step: 0.5 },
  { key: "tilt", label: "Tilt", min: -90, max: 90, step: 0.5 },
  { section: "Camera" },
  { key: "zoom", label: "Zoom", min: 0, max: 100, step: 0.1 },
];
const angleKeys = ["rotX", "rotY", "rotZ", "longitude"];

const shot = structuredClone(defaultShot);

// Sequences (sequence.js) assign tickShotSequence so the tween updates `shot` each frame.
// applyShot runs in preRender (after Cesium's update) so nothing can nudge the camera afterward.
var tickShotSequence = null;
// Gentle idle Earth spin (degrees per second). Pauses while dragging / G-R-S, or when Spin is unchecked.
const IDLE_SPIN_DEG_PER_SEC = 8;
const idleSpinToggle = document.getElementById("idleSpin");
let lastIdleSpinTime = performance.now();
let lastIdleSpinPanel = 0;

scene.preUpdate.addEventListener(() => {
  if (tickShotSequence) tickShotSequence();

  // Keep spinning during sequences too; only pause for direct user spin/edit, Spin off, or an oil-line focus.
  const now = performance.now();
  const spinEnabled = !idleSpinToggle || idleSpinToggle.checked;
  if (spinEnabled && !drag && !modal && !oilFocusLock) {
    const dt = Math.min(0.05, (now - lastIdleSpinTime) / 1000);
    lastIdleSpinTime = now;
    shot.longitude = wrapAngle(shot.longitude + IDLE_SPIN_DEG_PER_SEC * dt);
    if (now - lastIdleSpinPanel > 250) {
      lastIdleSpinPanel = now;
      renderShotControls();
    }
  } else {
    lastIdleSpinTime = now;
  }
});
scene.preRender.addEventListener(() => applyShot(shot));

function wrapAngle(degrees) {
  return ((((degrees + 180) % 360) + 360) % 360) - 180;
}

function setShot(changes, { updatePanel = true } = {}) {
  Object.assign(shot, changes);
  angleKeys.forEach((key) => (shot[key] = wrapAngle(shot[key])));
  shot.zoom = Cesium.Math.clamp(shot.zoom, 0, 100);
  shot.tilt = Cesium.Math.clamp(shot.tilt, -90, 90);
  if (updatePanel) renderShotControls();
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

const shotControls = document.getElementById("shotControls");
const shotInputs = [];

for (const field of shotFields) {
  if (field.section) {
    const heading = document.createElement("h4");
    heading.textContent = field.section;
    shotControls.appendChild(heading);
    continue;
  }
  const row = document.createElement("label");
  const slider = document.createElement("input");
  const number = document.createElement("input");
  Object.assign(slider, { type: "range", min: field.min, max: field.max, step: field.step });
  Object.assign(number, { type: "number", step: field.step });
  slider.addEventListener("input", () => setShot({ [field.key]: Number(slider.value) }));
  // "change" rather than "input" so half-typed values like "-" aren't applied.
  number.addEventListener("change", () => {
    if (number.value !== "") setShot({ [field.key]: Number(number.value) });
  });
  row.append(field.label, slider, number);
  shotControls.appendChild(row);
  shotInputs.push(() => {
    slider.value = shot[field.key];
    if (document.activeElement !== number) number.value = Math.round(shot[field.key] * 100) / 100;
  });
}

const altitudeReadout = document.getElementById("altitudeReadout");
const objectOrigin = document.getElementById("objectOrigin");

function objectScreenPosition(target = shot) {
  const rect = viewer.canvas.getBoundingClientRect();
  return {
    x: rect.left + ((1 + target.x / 100) / 2) * rect.width,
    y: rect.top + ((1 - target.y / 100) / 2) * rect.height,
  };
}

function renderShotControls() {
  shotInputs.forEach((update) => update());
  const kilometres = (zoomToAltitude(shot.zoom) * EARTH_RADIUS) / 1000;
  altitudeReadout.textContent = `Camera height: ${Math.round(kilometres).toLocaleString()} km`;
  const origin = objectScreenPosition();
  objectOrigin.style.left = `${origin.x}px`;
  objectOrigin.style.top = `${origin.y}px`;
}

window.addEventListener("resize", renderShotControls);

document.getElementById("copyShot").addEventListener("click", (event) => {
  const rounded = Object.fromEntries(Object.entries(shot).map(([key, value]) => [key, Math.round(value * 100) / 100]));
  copyText(event.currentTarget, JSON.stringify(rounded));
});

document.getElementById("resetShot").addEventListener("click", () => setShot(structuredClone(defaultShot)));

// ---------------------------------------------------------------------------
// Edit mode: mouse drags
// ---------------------------------------------------------------------------

const editMode = document.getElementById("editMode");
const editHelp = document.getElementById("editHelp");
const viewHelp = document.getElementById("viewHelp");
const canvas = viewer.canvas;

editMode.addEventListener("change", () => {
  if (!editMode.checked && modal) cancelModal();
  document.body.classList.toggle("editing", editMode.checked);
  editHelp.hidden = !editMode.checked;
  viewHelp.hidden = editMode.checked;
  objectOrigin.hidden = !editMode.checked;
});

// Degrees of globe spin per pixel, slower when zoomed in so the surface tracks the mouse.
function spinSpeed() {
  return 0.3 * Cesium.Math.clamp(zoomToAltitude(shot.zoom) / 2, 0.0005, 1);
}

let drag = null;

canvas.addEventListener("pointerdown", (event) => {
  if (modal) {
    if (event.button === 0) confirmModal();
    else cancelModal();
    event.preventDefault();
    return;
  }
  if (event.button !== 0) return;
  let mode = "spin";
  if (editMode.checked && !event.altKey) mode = event.shiftKey ? "rotate" : event.ctrlKey ? "roll" : "move";
  drag = { mode, x: event.clientX, y: event.clientY };
  canvas.setPointerCapture(event.pointerId);
});

canvas.addEventListener("pointermove", (event) => {
  if (!drag) return;
  const dx = event.clientX - drag.x;
  const dy = event.clientY - drag.y;
  drag.x = event.clientX;
  drag.y = event.clientY;
  const rect = canvas.getBoundingClientRect();
  if (drag.mode === "move") setShot({ x: shot.x + (dx / rect.width) * 200, y: shot.y - (dy / rect.height) * 200 });
  if (drag.mode === "rotate") setShot({ rotY: shot.rotY + dx * 0.4, rotX: shot.rotX + dy * 0.4 });
  if (drag.mode === "roll") setShot({ rotZ: shot.rotZ - dx * 0.4 });
  if (drag.mode === "spin") setShot({ longitude: shot.longitude - dx * spinSpeed(), tilt: shot.tilt + dy * spinSpeed() });
});

canvas.addEventListener("pointerup", () => (drag = null));
canvas.addEventListener("pointercancel", () => (drag = null));
canvas.addEventListener("contextmenu", (event) => event.preventDefault());

canvas.addEventListener(
  "wheel",
  (event) => {
    event.preventDefault();
    setShot({ zoom: shot.zoom - event.deltaY * 0.02 });
  },
  { passive: false },
);

// ---------------------------------------------------------------------------
// Edit mode: Blender-style G / R / S
// ---------------------------------------------------------------------------

const modalStatus = document.getElementById("modalStatus");
const modalNames = { g: "Move", r: "Rotate", s: "Zoom" };
let modal = null;
let mouse = { x: 0, y: 0 };

window.addEventListener("pointermove", (event) => {
  mouse = { x: event.clientX, y: event.clientY };
  if (modal) updateModal();
});

window.addEventListener("keydown", (event) => {
  const typing = event.target instanceof Element && event.target.matches("input, textarea");
  if (!editMode.checked || typing || event.ctrlKey || event.metaKey) return;
  const key = event.key.toLowerCase();
  if (modal) {
    if (key === "escape") cancelModal();
    else if (key === "enter") confirmModal();
    else if (key === "x" || key === "y" || key === "z") {
      modal.axis = modal.axis === key ? null : key;
      updateModal();
    } else return;
  } else if (modalNames[key]) {
    modal = { type: key, axis: null, start: structuredClone(shot), mouse: { ...mouse } };
    updateModal();
  } else return;
  event.preventDefault();
});

function updateModal() {
  const start = modal.start;
  const dx = mouse.x - modal.mouse.x;
  const dy = mouse.y - modal.mouse.y;
  const rect = canvas.getBoundingClientRect();
  const changes = structuredClone(start);
  const center = objectScreenPosition(start);

  if (modal.type === "g") {
    if (modal.axis !== "y") changes.x = start.x + (dx / rect.width) * 200;
    if (modal.axis !== "x") changes.y = start.y - (dy / rect.height) * 200;
  } else if (modal.type === "r") {
    if (modal.axis === "x") changes.rotX = start.rotX + dy * 0.4;
    else if (modal.axis === "y") changes.rotY = start.rotY + dx * 0.4;
    else {
      // Around the view axis, following the mouse around the object's centre.
      const before = Math.atan2(modal.mouse.y - center.y, modal.mouse.x - center.x);
      const after = Math.atan2(mouse.y - center.y, mouse.x - center.x);
      changes.rotZ = start.rotZ - Cesium.Math.toDegrees(after - before);
    }
  } else if (modal.type === "s") {
    const before = Math.hypot(modal.mouse.x - center.x, modal.mouse.y - center.y);
    const after = Math.hypot(mouse.x - center.x, mouse.y - center.y);
    if (before > 1 && after > 1) {
      const distance = (1 + zoomToAltitude(start.zoom)) * (before / after);
      changes.zoom = altitudeToZoom(Math.max(distance - 1, NEAR_ALTITUDE));
    }
  }
  setShot(changes);

  const axisText = modal.axis ? ` along ${modal.axis.toUpperCase()}` : "";
  const values = {
    g: `X ${shot.x.toFixed(1)}  Y ${shot.y.toFixed(1)}`,
    r: `X ${shot.rotX.toFixed(1)}°  Y ${shot.rotY.toFixed(1)}°  Z ${shot.rotZ.toFixed(1)}°`,
    s: `Zoom ${shot.zoom.toFixed(1)}`,
  }[modal.type];
  modalStatus.textContent = `${modalNames[modal.type]}${axisText}: ${values}   (click/Enter confirm · Esc cancel)`;
  modalStatus.hidden = false;
}

function confirmModal() {
  modal = null;
  modalStatus.hidden = true;
}

function cancelModal() {
  setShot(modal.start);
  confirmModal();
}

renderShotControls();
