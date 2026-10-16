// Shot animation sequences. One continuous tween on Cesium's clock.
// Camera shots and appearance effects (e.g. smoke reach) share the same timeline.

const sequences = [
  {
    name: "Idle → reveal",
    duration: 5.5,
    ease: "easeInOutSine",
    from: structuredClone(defaultShot),
    to: { x: -38.33, y: -4.81, rotX: 0, rotY: 23, rotZ: 0, longitude: 29.2, tilt: 1.5, zoom: 12.5 },
    // Smoke bloom: tight → disperse mid-move → settle back. Times are 0..1 along the sequence.
    effects: [
      { t: 0, smokeReach: 4 },
      { t: 0.38, smokeReach: 120 },
      { t: 1, smokeReach: 4 },
    ],
  },
];

const easings = {
  linear: (t) => t,
  easeInOutSine: (t) => (1 - Math.cos(Math.PI * t)) / 2,
};

const defaultSmokeReach = defaultSettings.objectSmoke.reach;
const defaultSmokeAmount = defaultSettings.objectSmoke.amount;

function withoutLongitude(values) {
  const { longitude, ...rest } = values;
  return rest;
}

function lerpShot(from, to, t) {
  const result = {};
  for (const key of Object.keys(from)) {
    // Longitude is owned by the idle spin — leave it alone so the Earth keeps turning.
    if (key === "longitude" || typeof from[key] !== "number") continue;
    const a = from[key];
    const b = to[key] ?? a;
    if (angleKeys.includes(key)) {
      const delta = ((((b - a) % 360) + 540) % 360) - 180;
      result[key] = a + delta * t;
    } else {
      result[key] = a + (b - a) * t;
    }
  }
  return result;
}

// Piecewise ease between effect keyframes (each segment uses the sequence's ease curve).
function sampleEffects(keyframes, t, ease) {
  if (!keyframes?.length) return null;
  const sorted = keyframes;
  if (t <= sorted[0].t) return { ...sorted[0] };
  if (t >= sorted[sorted.length - 1].t) return { ...sorted[sorted.length - 1] };
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (t < a.t || t > b.t) continue;
    const local = (t - a.t) / Math.max(b.t - a.t, 1e-6);
    const u = ease(local);
    const out = { t };
    for (const key of Object.keys(a)) {
      if (key === "t" || typeof a[key] !== "number") continue;
      out[key] = a[key] + ((b[key] ?? a[key]) - a[key]) * u;
    }
    return out;
  }
  return { ...sorted[sorted.length - 1] };
}

function applyEffects(sample) {
  if (!sample) return;
  if (sample.smokeReach != null) settings.objectSmoke.reach = sample.smokeReach;
  if (sample.smokeAmount != null) settings.objectSmoke.amount = sample.smokeAmount;
}

function restoreEffects() {
  settings.objectSmoke.reach = defaultSmokeReach;
  settings.objectSmoke.amount = defaultSmokeAmount;
  renderGrainControls();
}

let playing = null;
let playToken = 0;
let sequenceDriving = false;
let activeTween = null;
let lastEffectsPanelUpdate = 0;

const applyShotValues = setShot;
setShot = function setShotMaybeCancel(changes, options) {
  if (playing && !sequenceDriving) stopSequence();
  return applyShotValues(changes, options);
};

function stopSequence() {
  playToken += 1;
  playing = null;
  sequenceDriving = false;
  activeTween = null;
  restoreEffects();
  updateSequenceButtons();
  renderShotControls();
}

const HITCH_THRESHOLD = 0.1;

tickShotSequence = () => {
  if (!activeTween) return;
  const { token, from, to, duration, ease, effects } = activeTween;
  if (token !== playToken) {
    activeTween = null;
    return;
  }

  const now = performance.now();
  let delta = (now - activeTween.lastTime) / 1000;
  activeTween.lastTime = now;
  if (delta > HITCH_THRESHOLD) delta = 1 / 60;
  if (activeTween.armed) activeTween.elapsed += delta;
  else activeTween.armed = true;

  const t = Math.min(1, activeTween.elapsed / duration);
  sequenceDriving = true;
  applyShotValues(lerpShot(from, to, ease(t)), { updatePanel: false });
  applyEffects(sampleEffects(effects, t, ease));
  sequenceDriving = false;

  if (now - lastEffectsPanelUpdate > 200 || t >= 1) {
    lastEffectsPanelUpdate = now;
    renderGrainControls();
  }

  if (t >= 1) {
    sequenceDriving = true;
    applyShotValues(withoutLongitude(to));
    applyEffects(sampleEffects(effects, 1, ease));
    sequenceDriving = false;
    activeTween = null;
    if (token === playToken) stopSequence();
  }
};

async function playSequence(sequence) {
  stopSequence();
  const token = playToken;
  const from = structuredClone(sequence.from ?? defaultShot);
  const to = structuredClone(sequence.to);
  const ease = easings[sequence.ease] ?? easings.easeInOutSine;
  const effects = (sequence.effects ?? []).map((frame) => ({ ...frame }));

  // Stay on the visible idle pose — no hidden preload (that was the blue flash).
  // Don't touch longitude so the idle spin continues unbroken into the move.
  sequenceDriving = true;
  applyShotValues(withoutLongitude(from));
  applyEffects({ smokeReach: defaultSmokeReach, smokeAmount: defaultSmokeAmount });
  sequenceDriving = false;
  if (token !== playToken) return;

  playing = sequence.name;
  updateSequenceButtons();
  lastEffectsPanelUpdate = 0;

  activeTween = {
    token,
    from,
    to,
    effects,
    duration: sequence.duration ?? 5,
    ease,
    elapsed: 0,
    lastTime: performance.now(),
    armed: false,
  };
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

const sequenceControls = document.getElementById("sequenceControls");
const sequenceButtons = new Map();

for (const sequence of sequences) {
  const button = document.createElement("button");
  button.className = "wide-button";
  button.textContent = sequence.name;
  button.addEventListener("click", () => {
    if (playing === sequence.name) stopSequence();
    else playSequence(sequence);
  });
  sequenceControls.appendChild(button);
  sequenceButtons.set(sequence.name, button);
}

function updateSequenceButtons() {
  for (const [name, button] of sequenceButtons) {
    button.classList.toggle("active", playing === name);
    button.textContent = playing === name ? `Stop · ${name}` : name;
  }
}

// Stay on the idle shot until the user clicks a sequence.
standReady.then(() => {
  sequenceDriving = true;
  applyShotValues(structuredClone(defaultShot));
  applyEffects({ smokeReach: defaultSmokeReach, smokeAmount: defaultSmokeAmount });
  sequenceDriving = false;
  renderGrainControls();
});
