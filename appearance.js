const defaultSettings = {
  backgroundColor: "#3c5c8c",
  earthGrain: { enabled: true, amount: 0.08, size: 1, speed: 15 },
  backgroundGrain: { enabled: true, amount: 0.07, size: 1.5, speed: 10 },
  backgroundPatches: { enabled: true, color: "#15375d", amount: 0.9, size: 420, speed: 4, swirl: 4, blur: 1 },
  objectSmoke: { enabled: true, color: "#c3d9f2", amount: 0.7, reach: 4, size: 40, speed: 6, swirl: 2, holder: 0 },
};

const smokeSliders = [
  { field: "amount", label: "Amount", min: 0, max: 1, step: 0.05 },
  { field: "reach", label: "Reach", min: 4, max: 120, step: 2 },
  { field: "size", label: "Size", min: 40, max: 500, step: 10 },
  { field: "speed", label: "Flow", min: 0, max: 30, step: 1 },
  { field: "swirl", label: "Swirl", min: 0, max: 8, step: 0.5 },
  { field: "holder", label: "Holder", min: 0, max: 1, step: 0.05 },
];

const patchSliders = [
  { field: "amount", label: "Amount", min: 0, max: 1, step: 0.05 },
  { field: "size", label: "Size", min: 100, max: 900, step: 20 },
  { field: "speed", label: "Drift", min: 0, max: 20, step: 1 },
  { field: "swirl", label: "Swirl", min: 0, max: 8, step: 0.5 },
  { field: "blur", label: "Blur", min: 0, max: 1, step: 0.05 },
];

const grainLayers = [
  { key: "earthGrain", title: "Earth grain" },
  { key: "backgroundGrain", title: "Background grain" },
];

const grainSliders = [
  { field: "amount", label: "Amount", min: 0, max: 0.4, step: 0.01 },
  { field: "size", label: "Size", min: 1, max: 6, step: 0.5 },
  { field: "speed", label: "Speed", min: 0, max: 30, step: 1 },
];

// The panel is only for previewing changes; every page load starts from defaultSettings.
// Clears values that older versions of this page saved in the browser.
localStorage.removeItem("globe-appearance");

let settings = structuredClone(defaultSettings);

// ---------------------------------------------------------------------------
// Grain, ocean patches and object smoke: post-process passes that use the depth buffer to tell
// object pixels (something was drawn there) from background pixels (depth left at the far plane).
// ---------------------------------------------------------------------------

function grainUniform(grain) {
  const amount = grain.enabled ? grain.amount : 0;
  const seed = grain.speed > 0 ? Math.floor((performance.now() / 1000) * grain.speed) % 997 : 0;
  return new Cesium.Cartesian4(amount, grain.size, seed, 0);
}

function patchUniform(patches) {
  const amount = patches.enabled ? patches.amount : 0;
  const drift = (performance.now() / 1000) * patches.speed * 0.01;
  return new Cesium.Cartesian4(amount, patches.size, drift, patches.swirl);
}

function smokeUniform(smoke) {
  const amount = smoke.enabled ? smoke.amount : 0;
  const flow = (performance.now() / 1000) * smoke.speed * 0.02;
  return new Cesium.Cartesian4(amount, smoke.size, flow, smoke.swirl);
}

// Step between blur taps, in texture coordinates; 16 taps each side cover twice the reach.
function blurStep(horizontal) {
  const step = settings.objectSmoke.reach / 8;
  return horizontal
    ? new Cesium.Cartesian2(step / viewer.scene.drawingBufferWidth, 0)
    : new Cesium.Cartesian2(0, step / viewer.scene.drawingBufferHeight);
}

const noiseGlsl = `
      float hash(vec2 p) {
        p = fract(p * vec2(443.897, 441.423));
        p += dot(p, p.yx + 19.19);
        return fract((p.x + p.y) * p.x);
      }

      vec2 gradient(vec2 cell) {
        uvec2 q = uvec2(ivec2(cell) + 32768) * uvec2(1597334673u, 3812015801u);
        uint n = (q.x ^ q.y) * 1597334673u;
        float angle = float(n) * (6.28318530718 / 4294967295.0);
        return vec2(cos(angle), sin(angle));
      }

      // Gradient noise with quintic smoothing: unlike value noise, it has no visible grid creases.
      float gradientNoise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
        float a = dot(gradient(i), f);
        float b = dot(gradient(i + vec2(1.0, 0.0)), f - vec2(1.0, 0.0));
        float c = dot(gradient(i + vec2(0.0, 1.0)), f - vec2(0.0, 1.0));
        float d = dot(gradient(i + vec2(1.0, 1.0)), f - vec2(1.0, 1.0));
        return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
      }

      // Each octave is rotated so no layer lines up with the screen's horizontal and vertical axes.
      const mat2 octaveRotation = mat2(0.8, 0.6, -0.6, 0.8);

      // Blur works by fading out the finer octaves, which reads as soft focus without extra samples.
      float fbm(vec2 p, float blur) {
        float total = 0.0;
        float weight = 0.5;
        float falloff = 0.5 * mix(1.0, 0.55, blur);
        for (int i = 0; i < 5; i++) {
          total += gradientNoise(p) * weight;
          p = octaveRotation * p * 2.03 + vec2(17.1, 9.2);
          weight *= falloff;
        }
        return clamp(total + 0.5, 0.0, 1.0);
      }
`;

const earthTestGlsl = `
      // Whether the view ray through this pixel hits the Earth's ellipsoid. The depth texture alone isn't
      // reliable for this: when zoomed in, Cesium renders in several frustums and clears depth between them.
      // Distance along the view axis (eye-space depth) to where the view ray through uv meets the
      // Earth's ellipsoid, or -1.0 if it misses.
      float earthDepth(vec2 uv) {
        vec4 eye = czm_inverseProjection * vec4(uv * 2.0 - 1.0, 1.0, 1.0);
        vec3 eyeDirection = normalize(eye.xyz / eye.w);
        vec3 direction = czm_inverseViewRotation * eyeDirection;
        vec3 origin = czm_viewerPositionWC * czm_ellipsoidInverseRadii;
        direction *= czm_ellipsoidInverseRadii;
        float a = dot(direction, direction);
        float b = dot(origin, direction);
        float c = dot(origin, origin) - 1.0;
        float discriminant = b * b - a * c;
        if (discriminant < 0.0 || b >= 0.0) return -1.0;
        float distance = (-b - sqrt(discriminant)) / a;
        return distance * -eyeDirection.z;
      }

      bool rayHitsEarth(vec2 uv) {
        return earthDepth(uv) > 0.0;
      }

      // Earth or the stand: something was drawn here.
      bool isObject(vec2 uv) {
        return rayHitsEarth(uv) || texture(depthTexture, uv).r < 1.0;
      }

      // Undoes Cesium's logarithmic depth: eye-space depth = 2^(depth * log2(far - near + 1)) - 1 + near.
      // Use czm_entireFrustum (not a JS-sampled frustum list) so Oil overlays can't skew near/far
      // and drop the stand out of the smoke mask.
      float drawnDepth(float depth) {
        float near = czm_entireFrustum.x;
        float far = czm_entireFrustum.y;
        return exp2(depth * log2(far - near + 1.0)) - 1.0 + near;
      }

      // The stand is whatever was drawn either off the Earth or clearly in front of its surface.
      bool isStand(vec2 uv) {
        float depth = texture(depthTexture, uv).r;
        if (depth >= 1.0) return false;
        float earth = earthDepth(uv);
        return earth < 0.0 || drawnDepth(depth) < earth * 0.997;
      }
`;

// Half-resolution mask of the stand alone, blurred into a soft halo that the smoke follows.
const objectMask = new Cesium.PostProcessStage({
  name: "globeObjectMask",
  textureScale: 0.5,
  fragmentShader: `
      uniform sampler2D colorTexture;
      uniform sampler2D depthTexture;
      in vec2 v_textureCoordinates;
      ${earthTestGlsl}
      void main() {
        out_FragColor = vec4(isStand(v_textureCoordinates) ? 1.0 : 0.0);
      }
    `,
});

function blurStage(name, source, horizontal) {
  return new Cesium.PostProcessStage({
    name,
    textureScale: 0.5,
    fragmentShader: `
      uniform sampler2D colorTexture;
      uniform sampler2D source;
      uniform vec2 tapStep;
      in vec2 v_textureCoordinates;
      void main() {
        float total = 0.0;
        float weights = 0.0;
        for (int i = -16; i <= 16; i++) {
          float weight = exp(-float(i * i) / 32.0);
          total += texture(source, v_textureCoordinates + tapStep * float(i)).r * weight;
          weights += weight;
        }
        out_FragColor = vec4(total / weights);
      }
    `,
    uniforms: { source, tapStep: () => blurStep(horizontal) },
  });
}

const appearanceStage = new Cesium.PostProcessStage({
  name: "globeAppearance",
  fragmentShader: `
      uniform sampler2D colorTexture;
      uniform sampler2D depthTexture;
      uniform sampler2D objectGlow;
      uniform vec4 backgroundColor;
      uniform float smokeHolder;
      uniform vec4 earthGrain;
      uniform vec4 backgroundGrain;
      uniform vec4 patches;
      uniform vec4 patchColor;
      uniform float patchBlur;
      uniform vec4 smoke;
      uniform vec4 smokeColor;
      uniform vec2 smokeReach;
      in vec2 v_textureCoordinates;
      ${noiseGlsl}
      ${earthTestGlsl}

      // Manual bilinear filtering: the half-resolution mask textures are sampled with nearest filtering.
      float sampleSmooth(sampler2D source, vec2 uv) {
        vec2 size = vec2(textureSize(source, 0));
        vec2 p = clamp(uv, 0.0, 1.0) * size - 0.5;
        vec2 f = fract(p);
        ivec2 i = ivec2(floor(p));
        ivec2 last = ivec2(size) - 1;
        float a = texelFetch(source, clamp(i, ivec2(0), last), 0).r;
        float b = texelFetch(source, clamp(i + ivec2(1, 0), ivec2(0), last), 0).r;
        float c = texelFetch(source, clamp(i + ivec2(0, 1), ivec2(0), last), 0).r;
        float d = texelFetch(source, clamp(i + ivec2(1, 1), ivec2(0), last), 0).r;
        return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
      }

      void main() {
        vec4 color = texture(colorTexture, v_textureCoordinates);
        bool isEarth = isObject(v_textureCoordinates);

        // Fading the real stand out leaves only its smoke form; it's replaced by the background
        // (the Earth behind it isn't known, so this is only done off the Earth).
        bool onStand = isStand(v_textureCoordinates);
        bool behindIsSky = !rayHitsEarth(v_textureCoordinates);
        if (onStand && behindIsSky && smokeHolder < 1.0) {
          color.rgb = mix(backgroundColor.rgb, color.rgb, smokeHolder);
          isEarth = smokeHolder > 0.5;
        }

        if (!isEarth && patches.x > 0.0) {
          // Slightly wider than tall so the shapes read as drifting smoke rather than round blobs.
          vec2 p = gl_FragCoord.xy / patches.y * vec2(0.55, 0.75);
          float t = patches.z;
          float swirl = patches.w;

          // Two rounds of domain warping bend the noise into curling, smoke-like plumes.
          // The warp layers stay sharp so blur softens the smoke without flattening its swirls.
          vec2 q = vec2(fbm(p + vec2(0.0, t), 0.0), fbm(p + vec2(5.2, 1.3) - vec2(t * 0.7, 0.0), 0.0));
          vec2 r = vec2(
            fbm(p + swirl * q + vec2(1.7, 9.2) + t * 0.5, 0.0),
            fbm(p + swirl * q + vec2(8.3, 2.8) - t * 0.4, 0.0)
          );
          float density = fbm(p + swirl * r, patchBlur);

          // Ridged noise along the flow adds thin wisps at the edges of the plumes.
          float wisps = 1.0 - abs(fbm(p * 2.2 + r * swirl * 0.5 - t, patchBlur) * 2.0 - 1.0);
          float wispStrength = 1.0 - patchBlur * 0.6;
          density = mix(density, density * (0.55 + 0.7 * wisps), 0.6 * wispStrength);

          float edge = patchBlur * 0.08;
          float mask = smoothstep(0.3 - edge, 0.72 + edge, density) * patches.x;
          color.rgb = mix(color.rgb, patchColor.rgb, mask);
          color.rgb += pow(wisps, 8.0) * 0.07 * wispStrength * patches.x * (1.0 - mask);
        }

        // Smoke filling the stand's whole surface and fraying past its edges.
        if (smoke.x > 0.0) {
          vec2 p = gl_FragCoord.xy / smoke.y;
          float t = smoke.z;
          float swirl = smoke.w;
          // Warp field drifting upward, like rising smoke.
          vec2 q = vec2(fbm(p + vec2(0.0, -t), 0.0), fbm(p + vec2(4.7, 2.1) + vec2(t * 0.3, -t), 0.0));
          // Reading the halo through the warp frays the line into curling tendrils.
          float glow = sampleSmooth(objectGlow, v_textureCoordinates + (q - 0.5) * smokeReach * swirl * 0.5);
          if (glow > 0.001) {
            float body = fbm(p * 1.3 + q * swirl - vec2(0.0, t * 1.4), 0.25);
            float wisps = 1.0 - abs(fbm(p * 2.4 + q * swirl * 0.7 - vec2(t, t * 1.6), 0.0) * 2.0 - 1.0);
            float shell = smoothstep(0.0, 0.5, glow);
            float density = shell * smoothstep(0.2, 0.8, body * 0.8 + shell * 0.3) * (0.6 + 0.6 * pow(wisps, 3.0));
            color.rgb = mix(color.rgb, smokeColor.rgb, clamp(density, 0.0, 1.0) * smoke.x);
          }
        }

        vec4 grain = isEarth ? earthGrain : backgroundGrain;
        vec2 cell = floor(gl_FragCoord.xy / max(grain.y, 1.0));
        float noise = hash(cell * 0.013 + grain.z * 0.173) - 0.5;
        out_FragColor = vec4(clamp(color.rgb + noise * grain.x, 0.0, 1.0), 1.0);
      }
    `,
  uniforms: {
    earthGrain: () => grainUniform(settings.earthGrain),
    backgroundGrain: () => grainUniform(settings.backgroundGrain),
    patches: () => patchUniform(settings.backgroundPatches),
    patchColor: () => Cesium.Color.fromCssColorString(settings.backgroundPatches.color),
    patchBlur: () => settings.backgroundPatches.blur,
    objectGlow: "globeObjectBlurY",
    backgroundColor: () => Cesium.Color.fromCssColorString(settings.backgroundColor),
    smokeHolder: () => (settings.objectSmoke.enabled ? settings.objectSmoke.holder : 1),
    smoke: () => smokeUniform(settings.objectSmoke),
    smokeColor: () => Cesium.Color.fromCssColorString(settings.objectSmoke.color),
    smokeReach: () =>
      new Cesium.Cartesian2(
        settings.objectSmoke.reach / viewer.scene.drawingBufferWidth,
        settings.objectSmoke.reach / viewer.scene.drawingBufferHeight,
      ),
  },
});

// Every stage reads the scene's colour and depth; the blurs and the final pass find their inputs by stage name.
viewer.scene.postProcessStages.add(
  new Cesium.PostProcessStageComposite({
    stages: [
      objectMask,
      blurStage("globeObjectBlurX", "globeObjectMask", true),
      blurStage("globeObjectBlurY", "globeObjectBlurX", false),
      appearanceStage,
    ],
    inputPreviousStageTexture: false,
  }),
);

// ---------------------------------------------------------------------------
// Background color
// ---------------------------------------------------------------------------

function applyBackgroundColor() {
  viewer.scene.backgroundColor = Cesium.Color.fromCssColorString(settings.backgroundColor);
  document.body.style.background = settings.backgroundColor;
}

function hsvToHex(h, s, v) {
  const f = (n) => {
    const k = (n + h / 60) % 6;
    return Math.round((v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255);
  };
  return "#" + [f(5), f(3), f(1)].map((c) => c.toString(16).padStart(2, "0")).join("");
}

function hexToHsv(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const delta = max - Math.min(r, g, b);
  let h = 0;
  if (delta) {
    if (max === r) h = 60 * (((g - b) / delta) % 6);
    else if (max === g) h = 60 * ((b - r) / delta + 2);
    else h = 60 * ((r - g) / delta + 4);
  }
  return { h: (h + 360) % 360, s: max ? delta / max : 0, v: max };
}

const wheel = document.getElementById("colorWheel");
const wheelHandle = document.getElementById("wheelHandle");
const brightness = document.getElementById("brightness");
const brightnessValue = document.getElementById("brightnessValue");
const swatch = document.getElementById("swatch");
const hexInput = document.getElementById("hexInput");

let hsv = hexToHsv(settings.backgroundColor);

function renderColorControls() {
  const radius = wheel.clientWidth / 2;
  const angle = (hsv.h * Math.PI) / 180;
  wheelHandle.style.left = `${radius + Math.sin(angle) * hsv.s * radius}px`;
  wheelHandle.style.top = `${radius - Math.cos(angle) * hsv.s * radius}px`;
  wheelHandle.style.background = settings.backgroundColor;
  wheel.style.setProperty("--darkness", 1 - hsv.v);
  brightness.value = Math.round(hsv.v * 100);
  brightnessValue.textContent = `${brightness.value}%`;
  swatch.style.background = settings.backgroundColor;
  if (document.activeElement !== hexInput) hexInput.value = settings.backgroundColor;
}

function setColorFromHsv() {
  settings.backgroundColor = hsvToHex(hsv.h, hsv.s, hsv.v);
  applyBackgroundColor();
  renderColorControls();
}

function pickFromWheel(event) {
  const rect = wheel.getBoundingClientRect();
  const radius = rect.width / 2;
  const dx = event.clientX - rect.left - radius;
  const dy = event.clientY - rect.top - radius;
  hsv.h = ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
  hsv.s = Math.min(1, Math.hypot(dx, dy) / radius);
  setColorFromHsv();
}

wheel.addEventListener("pointerdown", (event) => {
  wheel.setPointerCapture(event.pointerId);
  pickFromWheel(event);
});
wheel.addEventListener("pointermove", (event) => {
  if (wheel.hasPointerCapture(event.pointerId)) pickFromWheel(event);
});

brightness.addEventListener("input", () => {
  hsv.v = brightness.value / 100;
  setColorFromHsv();
});

hexInput.addEventListener("input", () => {
  const value = hexInput.value.trim();
  const hex = value.startsWith("#") ? value : `#${value}`;
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return;
  settings.backgroundColor = hex.toLowerCase();
  hsv = hexToHsv(settings.backgroundColor);
  applyBackgroundColor();
  renderColorControls();
});
hexInput.addEventListener("blur", renderColorControls);

// ---------------------------------------------------------------------------
// Copy buttons and screen color picker
// ---------------------------------------------------------------------------

async function copyText(button, text) {
  const label = button.textContent;
  await navigator.clipboard.writeText(text);
  button.textContent = "Copied!";
  setTimeout(() => (button.textContent = label), 1500);
}

document.getElementById("copyBackground").addEventListener("click", (event) => {
  copyText(event.currentTarget, settings.backgroundColor);
});

const pickedRow = document.getElementById("pickedRow");
const pickedSwatch = document.getElementById("pickedSwatch");
const pickedHex = document.getElementById("pickedHex");
const usePicked = document.getElementById("usePicked");
const pickerMessage = document.getElementById("pickerMessage");
let pickedColor = null;

document.getElementById("pickColor").addEventListener("click", async () => {
  if (!("EyeDropper" in window)) {
    pickerMessage.textContent = "This browser has no screen color picker. Try Chrome or Edge.";
    pickerMessage.hidden = false;
    return;
  }
  try {
    const { sRGBHex } = await new EyeDropper().open();
    pickedColor = sRGBHex.toLowerCase();
  } catch {
    return; // Picking was cancelled with Escape.
  }
  pickedSwatch.style.background = pickedColor;
  pickedHex.textContent = pickedColor;
  pickedRow.hidden = false;
  usePicked.hidden = false;
  pickerMessage.hidden = true;
});

document.getElementById("copyPicked").addEventListener("click", (event) => {
  if (pickedColor) copyText(event.currentTarget, pickedColor);
});

usePicked.addEventListener("click", () => {
  if (!pickedColor) return;
  settings.backgroundColor = pickedColor;
  hsv = hexToHsv(pickedColor);
  applyBackgroundColor();
  renderColorControls();
});

// ---------------------------------------------------------------------------
// Patch and grain controls
// ---------------------------------------------------------------------------

const grainControls = document.getElementById("grainControls");
const grainInputs = [];

function addEffectSection(title, key, sliders, { withColor = false } = {}) {
  const heading = document.createElement("h4");
  heading.textContent = title;
  grainControls.appendChild(heading);

  const toggle = document.createElement("label");
  toggle.className = "toggle";
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.addEventListener("change", () => {
    settings[key].enabled = checkbox.checked;
  });
  toggle.append(checkbox, "On");
  grainControls.appendChild(toggle);
  grainInputs.push(() => (checkbox.checked = settings[key].enabled));

  if (withColor) {
    const row = document.createElement("label");
    const picker = document.createElement("input");
    const hex = document.createElement("output");
    picker.type = "color";
    picker.addEventListener("input", () => {
      settings[key].color = picker.value;
      hex.textContent = picker.value;
    });
    row.append("Color", picker, hex);
    grainControls.appendChild(row);
    grainInputs.push(() => {
      picker.value = settings[key].color;
      hex.textContent = settings[key].color;
    });
  }

  for (const slider of sliders) {
    const row = document.createElement("label");
    const input = document.createElement("input");
    const output = document.createElement("output");
    Object.assign(input, { type: "range", min: slider.min, max: slider.max, step: slider.step });
    input.addEventListener("input", () => {
      settings[key][slider.field] = Number(input.value);
      output.textContent = input.value;
    });
    row.append(slider.label, input, output);
    grainControls.appendChild(row);
    grainInputs.push(() => {
      input.value = settings[key][slider.field];
      output.textContent = input.value;
    });
  }
}

addEffectSection("Background patches", "backgroundPatches", patchSliders, { withColor: true });
addEffectSection("Object smoke", "objectSmoke", smokeSliders, { withColor: true });
for (const layer of grainLayers) {
  addEffectSection(layer.title, layer.key, grainSliders);
}

function renderGrainControls() {
  grainInputs.forEach((update) => update());
}

// ---------------------------------------------------------------------------
// Copy / reset
// ---------------------------------------------------------------------------

document.getElementById("copySettings").addEventListener("click", (event) => {
  copyText(event.currentTarget, JSON.stringify(settings, null, 2));
});

document.getElementById("resetSettings").addEventListener("click", () => {
  settings = structuredClone(defaultSettings);
  hsv = hexToHsv(settings.backgroundColor);
  applyBackgroundColor();
  renderColorControls();
  renderGrainControls();
});

applyBackgroundColor();
renderColorControls();
renderGrainControls();

// Clear any previous Oil-debug stand overrides (custom shader / silhouette outline).
standReady.then((model) => {
  if (!model) return;
  model.customShader = undefined;
  model.silhouetteSize = 0;
});
