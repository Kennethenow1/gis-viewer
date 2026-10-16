Cesium.Ion.defaultAccessToken =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJub25jZSI6IlBQWU53X25OY3JNWVRQREgiLCJqdGkiOiI0ODAxZWJjNC1mNzVlLTQ0ZTUtYjI2Yi1kYzU0Y2ZlYjE0ZjMiLCJpZCI6NTI1MzM1LCJzdWIiOiJrZW5uZXRoZW5vdzEyMyIsImlzcyI6Imh0dHBzOi8vYXBpLmNlc2l1bS5jb20iLCJhdWQiOiJ2aXMgcHJvaiIsImlhdCI6MTc5MjAyNDUwM30.gRPQKwfCa5DuEB9ogJCvTdbeJvuSzCTdOZLVfJN3uj0";

const viewer = new Cesium.Viewer("cesiumContainer", {
  baseLayer: false,
  creditContainer: document.createElement("div"),
  animation: false,
  baseLayerPicker: false,
  fullscreenButton: false,
  geocoder: false,
  homeButton: false,
  infoBox: false,
  navigationHelpButton: false,
  sceneModePicker: false,
  selectionIndicator: false,
  timeline: false,
  skyBox: false,
});

const mapStyles = [
  { name: "Satellite", assetId: 2 },
  { name: "Satellite + labels", assetId: 3 },
  { name: "Road map", assetId: 4 },
  { name: "Earth at Night", assetId: 3812 },
  // Satellite underneath; oil choropleth, then place labels, then flow entities on top.
  { name: "Oil", assetId: 2, overlay: "oil" },
];

const filters = document.getElementById("filters");
const oilLegend = document.getElementById("oilLegend");
const oilDetail = document.getElementById("oilDetail");
const buttons = [];
let selectedStyle = mapStyles[0];
let oilChoroplethLayer = null;
let oilLabelsLayer = null;
let oilEventSource = null; // Vienna marker only (entities); flows are depth-free primitives.
let oilMedia = null;
let oilTradeGeo = null;
let selectedFlowId = null;
// Pauses idle Earth spin while a flow line is focused (read by transform.js).
var oilFocusLock = false;
let focusTween = null;
let levitateTween = null;
// Arc build params keyed by iso3 so we can lift the selected segment.
const flowArcMeta = new Map();
// Visible flow primitives — depthMask:false so they never steal the stand smoke mask.
const oilFlowPrims = new Map();

// Left-HUD oil filters (framing, region, trade role, coverage, layers, countries).
const OIL_REGIONS = {
  americas: { label: "Americas", iso3: ["USA", "CAN", "BRA"] },
  europe: { label: "Europe", iso3: ["GBR", "DEU", "FRA", "ITA", "NOR"] },
  mena: { label: "Mid. East & Africa", iso3: ["SAU", "ARE", "KWT", "IRQ", "IRN", "NGA"] },
  asia: { label: "Asia-Pacific", iso3: ["CHN", "IND", "JPN", "KOR", "AUS"] },
  eurasia: { label: "Eurasia", iso3: ["RUS"] },
};

const oilFilter = {
  search: "",
  framings: { supportive: true, critical: true, mixed: true },
  regions: { americas: true, europe: true, mena: true, asia: true, eurasia: true },
  tradeRole: "all",
  articlesMin: 4,
  outletsMin: 2,
  countries: null, // null = all; Set of iso3 when customized
  layers: { flows: true, heat: true, labels: true, event: true },
};

const tradeBalanceByIso3 = new Map();
let oilFilterUiBuilt = false;

// Colorblind-safe strokes: shape differs, not only hue (long dash / dotted / dash-dot).
const FRAMING_STROKES = {
  supportive: { bits: 0b1111111100000000, dashLength: 36 },
  critical: { bits: 0b1010101010101010, dashLength: 14 },
  mixed: { bits: 0b1111110000110000, dashLength: 28 },
};

// Never test or write depth — Oil arcs must not touch the buffer the stand smoke mask reads.
const FLOW_RENDER_STATE = {
  depthTest: { enabled: false },
  depthMask: false,
};

function removeLayer(layer) {
  if (!layer) return;
  try {
    viewer.imageryLayers.remove(layer, false);
  } catch (_) {
    /* already gone */
  }
}

function removeOilFlowPrimitives() {
  for (const entry of oilFlowPrims.values()) {
    viewer.scene.primitives.remove(entry.dash);
    if (entry.base) viewer.scene.primitives.remove(entry.base);
  }
  oilFlowPrims.clear();
}

function clearOilOverlay() {
  removeLayer(oilChoroplethLayer);
  removeLayer(oilLabelsLayer);
  oilChoroplethLayer = null;
  oilLabelsLayer = null;
  focusTween = null;
  levitateTween = null;
  flowArcMeta.clear();
  oilFocusLock = false;
  selectedFlowId = null;
  removeOilFlowPrimitives();
  if (oilEventSource) {
    viewer.dataSources.remove(oilEventSource, true);
    oilEventSource = null;
  }
  if (oilLegend) oilLegend.hidden = true;
  if (oilDetail) oilDetail.hidden = true;
  if (legendEditMode?.checked) {
    legendEditMode.checked = false;
    setLegendEditing(false);
  }
  applyOilFilters();
}

async function loadOilTile() {
  const url = "data/oil-trade.png";
  const rectangle = Cesium.Rectangle.fromDegrees(-180, -90, 180, 90);
  if (Cesium.SingleTileImageryProvider.fromUrl) {
    return Cesium.SingleTileImageryProvider.fromUrl(url, { rectangle });
  }
  return new Cesium.SingleTileImageryProvider({ url, rectangle });
}

async function loadPlaceLabels() {
  const url =
    "https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer";
  if (Cesium.ArcGisMapServerImageryProvider?.fromUrl) {
    return Cesium.ArcGisMapServerImageryProvider.fromUrl(url);
  }
  return new Cesium.ArcGisMapServerImageryProvider({ url });
}

function approxKm(lon1, lat1, lon2, lat2) {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
}

// Soft curve from country toward Vienna: ECEF lerp, outward bulge, lateral fan.
// Short hops get extra lift so they don't collapse into a dash-blob on Austria.
// `levitate` (0..1) raises the selected arc when inspecting a country.
function curvedArc(lon1, lat1, lon2, lat2, { samples = 80, bend = 0, levitate = 0 } = {}) {
  const lift = Math.max(0, Math.min(1, levitate));
  // Keep arcs near the crust — tall bulges reach the camera and force a 2nd depth frustum,
  // which clears the stand smoke mask.
  const start = Cesium.Cartesian3.fromDegrees(lon1, lat1, 40000 + lift * 120000);
  const end = Cesium.Cartesian3.fromDegrees(lon2, lat2, 40000 + lift * 120000);
  const distanceKm = approxKm(lon1, lat1, lon2, lat2);
  const shortBoost = distanceKm < 2800 ? Cesium.Math.lerp(0.22, 0.06, distanceKm / 2800) : 0.06;
  const chordDir = Cesium.Cartesian3.subtract(end, start, new Cesium.Cartesian3());
  const mid = Cesium.Cartesian3.midpoint(start, end, new Cesium.Cartesian3());
  const radial = Cesium.Cartesian3.normalize(mid, new Cesium.Cartesian3());
  const lateral = Cesium.Cartesian3.cross(chordDir, radial, new Cesium.Cartesian3());
  if (Cesium.Cartesian3.magnitudeSquared(lateral) > 1e-12) {
    Cesium.Cartesian3.normalize(lateral, lateral);
  } else {
    Cesium.Cartesian3.clone(Cesium.Cartesian3.UNIT_Z, lateral);
  }

  const positions = [];
  const scratch = new Cesium.Cartesian3();
  const offset = new Cesium.Cartesian3();
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const chord = Cesium.Cartesian3.lerp(start, end, t, scratch);
    const surface = Cesium.Cartesian3.normalize(chord, new Cesium.Cartesian3());
    const arch = Math.sin(Math.PI * t);
    const bulge = arch * (0.14 + shortBoost + lift * 0.2);
    const radius = Cesium.Cartesian3.magnitude(chord) * (1 + bulge);
    Cesium.Cartesian3.multiplyByScalar(surface, radius, scratch);
    Cesium.Cartesian3.multiplyByScalar(lateral, bend * arch * 280000, offset);
    positions.push(Cesium.Cartesian3.add(scratch, offset, new Cesium.Cartesian3()));
  }
  return positions;
}

function framingColor(framing, framings) {
  return Cesium.Color.fromCssColorString(framings[framing]?.color ?? "#a8a29e");
}

function framingStroke(framing) {
  return FRAMING_STROKES[framing] ?? FRAMING_STROKES.mixed;
}

function makeFlowPrimitive(positions, width, material, id) {
  return viewer.scene.primitives.add(
    new Cesium.Primitive({
      geometryInstances: new Cesium.GeometryInstance({
        geometry: new Cesium.PolylineGeometry({
          positions,
          width,
          vertexFormat: Cesium.PolylineMaterialAppearance.VERTEX_FORMAT,
        }),
        id,
      }),
      appearance: new Cesium.PolylineMaterialAppearance({
        material,
        translucent: true,
        renderState: FLOW_RENDER_STATE,
      }),
      asynchronous: false,
      allowPicking: true,
    }),
  );
}

function dashMaterial(color, alpha, framing, patternBits) {
  const stroke = framingStroke(framing);
  return Cesium.Material.fromType("PolylineDash", {
    color: color.withAlpha(alpha),
    gapColor: Cesium.Color.TRANSPARENT,
    dashLength: stroke.dashLength,
    dashPattern: patternBits ?? stroke.bits,
  });
}

function solidMaterial(color, alpha) {
  return Cesium.Material.fromType("Color", { color: color.withAlpha(alpha) });
}

function currentLevitate(id) {
  if (!levitateTween || levitateTween.id !== id) {
    return selectedFlowId === id ? 1 : 0;
  }
  const t = Math.min(1, (performance.now() - levitateTween.start) / levitateTween.duration);
  const u = 0.5 - 0.5 * Math.cos(Math.PI * t);
  return levitateTween.from + (levitateTween.to - levitateTween.from) * u;
}

function rebuildFlowPrimitive(id, levitate) {
  const meta = flowArcMeta.get(id);
  const prev = oilFlowPrims.get(id);
  if (!meta || !prev || !oilMedia) return;
  const positions = curvedArc(meta.lon1, meta.lat1, meta.lon2, meta.lat2, {
    bend: meta.bend,
    levitate,
  });
  viewer.scene.primitives.remove(prev.dash);
  if (prev.base) viewer.scene.primitives.remove(prev.base);

  const selected = selectedFlowId === id;
  const dimmed = selectedFlowId && !selected;
  const color = framingColor(prev.framing, oilMedia.framings);
  const pickId = { flowId: id, country: prev.country, framing: prev.framing };
  const dashAlpha = selected ? 1 : dimmed ? 0.12 : 0.95;
  const dashWidth = selected ? 7 : dimmed ? 2.2 : 4.4;
  const baseAlpha = selected ? 0.45 : dimmed ? 0.04 : 0.2;
  const baseWidth = selected ? 3.2 : dimmed ? 1.2 : 2.2;
  const pattern = prev.dash.appearance.material.uniforms.dashPattern ?? framingStroke(prev.framing).bits;

  const base = makeFlowPrimitive(positions, baseWidth, solidMaterial(color, baseAlpha), pickId);
  const dash = makeFlowPrimitive(
    positions,
    dashWidth,
    dashMaterial(color, dashAlpha, prev.framing, pattern),
    pickId,
  );
  oilFlowPrims.set(id, { ...prev, base, dash, levitate });
}

function applyArcLevitate(id, levitate) {
  rebuildFlowPrimitive(id, levitate);
}

function styleFlowSelection() {
  for (const [id, entry] of oilFlowPrims) {
    rebuildFlowPrimitive(id, currentLevitate(id));
  }
}

function tickFlowDashCrawl() {
  if (!oilFlowPrims.size) return;
  const phase = Math.floor(performance.now() / 70) % 16;
  for (const entry of oilFlowPrims.values()) {
    const bits = framingStroke(entry.framing).bits;
    const pattern = ((bits << phase) | (bits >>> (16 - phase))) & 0xffff;
    const mat = entry.dash?.appearance?.material;
    if (mat?.uniforms) mat.uniforms.dashPattern = pattern;
  }
}

function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    if (yj === yi) continue;
    const hit = yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (hit) inside = !inside;
  }
  return inside;
}

function findTradeCountryAt(lon, lat) {
  if (!oilTradeGeo) return null;
  for (const feature of oilTradeGeo.features) {
    const geom = feature.geometry;
    if (!geom) continue;
    const polygons = geom.type === "Polygon" ? [geom.coordinates] : geom.type === "MultiPolygon" ? geom.coordinates : [];
    for (const polygon of polygons) {
      const ring = polygon[0];
      if (ring && pointInRing(lon, lat, ring)) return feature.properties;
    }
  }
  return null;
}

function mediaCountryByIso3(iso3) {
  return oilMedia?.countries?.find((c) => c.iso3 === iso3) ?? null;
}

function regionForIso3(iso3) {
  for (const [key, region] of Object.entries(OIL_REGIONS)) {
    if (region.iso3.includes(iso3)) return key;
  }
  return null;
}

function indexTradeBalances() {
  tradeBalanceByIso3.clear();
  if (!oilTradeGeo?.features) return;
  for (const feature of oilTradeGeo.features) {
    const { iso3, balance } = feature.properties ?? {};
    if (iso3 != null && balance != null) tradeBalanceByIso3.set(iso3, balance);
  }
}

function tradeRoleOf(iso3) {
  const balance = tradeBalanceByIso3.get(iso3);
  if (balance == null || balance === 0) return "unknown";
  return balance > 0 ? "exporter" : "importer";
}

function countryPassesOilFilter(country, { ignoreCountrySet = false } = {}) {
  if (!country) return false;
  if (!oilFilter.framings[country.framing]) return false;
  const region = regionForIso3(country.iso3);
  if (region && !oilFilter.regions[region]) return false;
  if (oilFilter.tradeRole !== "all") {
    const role = tradeRoleOf(country.iso3);
    if (role !== oilFilter.tradeRole) return false;
  }
  if ((country.articles ?? 0) < oilFilter.articlesMin) return false;
  if ((country.outlets ?? 0) < oilFilter.outletsMin) return false;
  if (
    !ignoreCountrySet &&
    oilFilter.countries instanceof Set &&
    !oilFilter.countries.has(country.iso3)
  ) {
    return false;
  }
  const q = oilFilter.search.trim().toLowerCase();
  if (q && !country.name.toLowerCase().includes(q) && !country.iso3.toLowerCase().includes(q)) {
    return false;
  }
  return true;
}

function countActiveOilFilters() {
  let n = 0;
  const framingOn = Object.values(oilFilter.framings).filter(Boolean).length;
  if (framingOn < 3) n += 1;
  const regionOn = Object.values(oilFilter.regions).filter(Boolean).length;
  if (regionOn < Object.keys(OIL_REGIONS).length) n += 1;
  if (oilFilter.tradeRole !== "all") n += 1;
  if (oilFilter.articlesMin > 4) n += 1;
  if (oilFilter.outletsMin > 2) n += 1;
  if (oilFilter.search.trim()) n += 1;
  if (oilFilter.countries instanceof Set) n += 1;
  const layers = oilFilter.layers;
  if (!layers.flows || !layers.heat || !layers.labels || !layers.event) n += 1;
  return n;
}

function applyOilFilters() {
  const badge = document.getElementById("filterBadge");
  const meta = document.getElementById("oilFilterMeta");
  const hint = document.getElementById("oilFilterHint");
  const bodySections = document.querySelectorAll("#oilFilterPanel .filter-section");
  const oilOn = selectedStyle?.overlay === "oil";

  if (hint) hint.hidden = oilOn;
  bodySections.forEach((el) => {
    el.style.opacity = oilOn ? "" : "0.45";
    el.style.pointerEvents = oilOn ? "" : "none";
  });

  let visible = 0;
  const total = oilFlowPrims.size;
  for (const [id, entry] of oilFlowPrims) {
    const pass = oilOn && oilFilter.layers.flows && countryPassesOilFilter(entry.country);
    if (entry.dash) entry.dash.show = pass;
    if (entry.base) entry.base.show = pass;
    if (pass) visible += 1;
  }

  if (oilChoroplethLayer) oilChoroplethLayer.show = oilOn && oilFilter.layers.heat;
  if (oilLabelsLayer) oilLabelsLayer.show = oilOn && oilFilter.layers.labels;
  if (oilEventSource) {
    for (const entity of oilEventSource.entities.values) {
      entity.show = oilOn && oilFilter.layers.event;
    }
  }

  if (selectedFlowId && oilFlowPrims.has(selectedFlowId)) {
    const selected = oilFlowPrims.get(selectedFlowId);
    if (selected && !(oilOn && oilFilter.layers.flows && countryPassesOilFilter(selected.country))) {
      hideOilDetail();
    }
  }

  const active = countActiveOilFilters();
  if (badge) {
    badge.dataset.count = String(active);
    badge.textContent = active ? String(active) : "";
  }
  if (meta) {
    if (!oilOn) meta.textContent = "Oil style inactive";
    else if (!oilFilter.layers.flows) meta.textContent = "Flows hidden";
    else meta.textContent = `Showing ${visible} of ${total || "…"} flows`;
  }

  refreshOilCountryFilterList();
}

function refreshOilCountryFilterList() {
  const host = document.getElementById("oilFilterCountries");
  if (!host || !oilMedia?.countries) return;
  const q = oilFilter.search.trim().toLowerCase();
  const selected = oilFilter.countries;
  host.replaceChildren();
  for (const country of oilMedia.countries) {
    if (q && !country.name.toLowerCase().includes(q) && !country.iso3.toLowerCase().includes(q)) {
      continue;
    }
    const row = document.createElement("label");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = !(selected instanceof Set) || selected.has(country.iso3);
    box.addEventListener("change", () => {
      const next = new Set(
        selected instanceof Set ? selected : oilMedia.countries.map((c) => c.iso3),
      );
      if (box.checked) next.add(country.iso3);
      else next.delete(country.iso3);
      oilFilter.countries = next.size === oilMedia.countries.length ? null : next;
      applyOilFilters();
    });
    row.append(box, document.createTextNode(` ${country.name}`));
    if (!countryPassesOilFilter(country, { ignoreCountrySet: true })) row.classList.add("dim");
    host.appendChild(row);
  }
}

function buildOilFilterUi() {
  if (oilFilterUiBuilt || !oilMedia) return;
  oilFilterUiBuilt = true;

  const framingHost = document.getElementById("oilFilterFramings");
  if (framingHost) {
    framingHost.replaceChildren();
    for (const [key, info] of Object.entries(oilMedia.framings)) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip on";
      chip.dataset.key = key;
      const swatch = document.createElement("span");
      swatch.className = "swatch";
      swatch.style.background = info.color;
      chip.append(swatch, document.createTextNode(info.label.replace(/ of the cut$/i, "")));
      chip.addEventListener("click", () => {
        oilFilter.framings[key] = !oilFilter.framings[key];
        chip.classList.toggle("on", oilFilter.framings[key]);
        applyOilFilters();
      });
      framingHost.appendChild(chip);
    }
  }

  const regionHost = document.getElementById("oilFilterRegions");
  if (regionHost) {
    regionHost.replaceChildren();
    for (const [key, region] of Object.entries(OIL_REGIONS)) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip on";
      chip.textContent = region.label;
      chip.addEventListener("click", () => {
        oilFilter.regions[key] = !oilFilter.regions[key];
        chip.classList.toggle("on", oilFilter.regions[key]);
        applyOilFilters();
      });
      regionHost.appendChild(chip);
    }
  }

  const arts = oilMedia.countries.map((c) => c.articles);
  const outs = oilMedia.countries.map((c) => c.outlets);
  const artMin = Math.min(...arts);
  const artMax = Math.max(...arts);
  const outMin = Math.min(...outs);
  const outMax = Math.max(...outs);
  const artSlider = document.getElementById("oilArticlesMin");
  const outSlider = document.getElementById("oilOutletsMin");
  if (artSlider) {
    artSlider.min = String(artMin);
    artSlider.max = String(artMax);
    artSlider.value = String(artMin);
    oilFilter.articlesMin = artMin;
  }
  if (outSlider) {
    outSlider.min = String(outMin);
    outSlider.max = String(outMax);
    outSlider.value = String(outMin);
    oilFilter.outletsMin = outMin;
  }

  applyOilFilters();
}

function resetOilFilters() {
  oilFilter.search = "";
  oilFilter.framings = { supportive: true, critical: true, mixed: true };
  oilFilter.regions = { americas: true, europe: true, mena: true, asia: true, eurasia: true };
  oilFilter.tradeRole = "all";
  oilFilter.countries = null;
  oilFilter.layers = { flows: true, heat: true, labels: true, event: true };
  const search = document.getElementById("oilFilterSearch");
  if (search) search.value = "";
  document.querySelectorAll("#oilFilterFramings .chip, #oilFilterRegions .chip").forEach((chip) => {
    chip.classList.add("on");
  });
  const roleAll = document.querySelector('input[name="oilTradeRole"][value="all"]');
  if (roleAll) roleAll.checked = true;
  if (oilMedia) {
    const arts = oilMedia.countries.map((c) => c.articles);
    const outs = oilMedia.countries.map((c) => c.outlets);
    oilFilter.articlesMin = Math.min(...arts);
    oilFilter.outletsMin = Math.min(...outs);
    const artSlider = document.getElementById("oilArticlesMin");
    const outSlider = document.getElementById("oilOutletsMin");
    const artOut = document.getElementById("oilArticlesOut");
    const outOut = document.getElementById("oilOutletsOut");
    if (artSlider) artSlider.value = String(oilFilter.articlesMin);
    if (outSlider) outSlider.value = String(oilFilter.outletsMin);
    if (artOut) artOut.textContent = `Min articles: ${oilFilter.articlesMin}`;
    if (outOut) outOut.textContent = `Min outlets: ${oilFilter.outletsMin}`;
  }
  for (const [id, el] of Object.entries({
    oilLayerFlows: "flows",
    oilLayerHeat: "heat",
    oilLayerLabels: "labels",
    oilLayerEvent: "event",
  })) {
    const input = document.getElementById(id);
    if (input) input.checked = true;
    oilFilter.layers[el] = true;
  }
  applyOilFilters();
}

function easeInOut(t) {
  return 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, Math.max(0, t)));
}

function flyToCountry(country) {
  oilFocusLock = true;
  const lonDelta = ((((country.lon - shot.longitude) % 360) + 540) % 360) - 180;
  focusTween = {
    start: performance.now(),
    duration: 1300,
    fromLon: shot.longitude,
    fromTilt: shot.tilt,
    fromZoom: shot.zoom,
    toLon: shot.longitude + lonDelta,
    toTilt: country.lat,
    toZoom: Cesium.Math.clamp(Math.max(shot.zoom, 10), 8, 16),
  };
}

function startLevitate(id, to) {
  const from = currentLevitate(id);
  levitateTween = { id, start: performance.now(), duration: 700, from, to };
}

function hideOilDetail() {
  const prev = selectedFlowId;
  selectedFlowId = null;
  oilFocusLock = false;
  focusTween = null;
  if (oilDetail) oilDetail.hidden = true;
  for (const [id] of oilFlowPrims) {
    if (id !== prev) rebuildFlowPrimitive(id, 0);
  }
  if (prev) startLevitate(prev, 0);
  else styleFlowSelection();
}

function showFlowDetail(country) {
  if (!oilDetail || !country) return;
  const prev = selectedFlowId;
  selectedFlowId = country.iso3;
  if (prev && prev !== country.iso3) rebuildFlowPrimitive(prev, 0);
  styleFlowSelection();
  startLevitate(country.iso3, 1);
  flyToCountry(country);
  const framingLabel = oilMedia.framings[country.framing]?.label ?? country.framing;
  oilDetail.innerHTML = `
    <button type="button" class="oil-detail-close" id="oilDetailClose">×</button>
    <h3>${country.name}</h3>
    <p class="oil-detail-meta">${country.articles} articles, ${country.outlets} outlets · ${framingLabel}</p>
    <p class="oil-detail-split">${country.supportive}% supportive · ${country.critical}% critical · ${country.neutral}% neutral</p>
    <p class="oil-detail-note">Sampled media framing of the OPEC+ decision — not the government’s official position.</p>
    <ul class="oil-detail-links">
      ${country.links
        .map(
          (link) =>
            `<li><a href="${link.url}" target="_blank" rel="noopener">${link.title}</a><span>${link.outlet}</span></li>`,
        )
        .join("")}
    </ul>
  `;
  oilDetail.hidden = false;
  document.getElementById("oilDetailClose")?.addEventListener("click", hideOilDetail);
}

viewer.scene.preUpdate.addEventListener(() => {
  const now = performance.now();
  if (focusTween) {
    const u = easeInOut((now - focusTween.start) / focusTween.duration);
    setShot(
      {
        longitude: focusTween.fromLon + (focusTween.toLon - focusTween.fromLon) * u,
        tilt: focusTween.fromTilt + (focusTween.toTilt - focusTween.fromTilt) * u,
        zoom: focusTween.fromZoom + (focusTween.toZoom - focusTween.fromZoom) * u,
      },
      { updatePanel: u >= 1 },
    );
    if (u >= 1) focusTween = null;
  }
  if (levitateTween) {
    const u = easeInOut((now - levitateTween.start) / levitateTween.duration);
    const lev = levitateTween.from + (levitateTween.to - levitateTween.from) * u;
    if (!levitateTween.lastBuild || now - levitateTween.lastBuild > 45 || u >= 1) {
      applyArcLevitate(levitateTween.id, lev);
      levitateTween.lastBuild = now;
    }
    if (u >= 1) levitateTween = null;
  }
  tickFlowDashCrawl();
});

async function showOilFlows() {
  if (!oilMedia) {
    oilMedia = await fetch("data/opec-media.json").then((r) => r.json());
  }
  if (!oilTradeGeo) {
    oilTradeGeo = await fetch("data/oil-trade.geojson").then((r) => r.json());
  }
  indexTradeBalances();

  removeOilFlowPrimitives();
  if (oilEventSource) {
    viewer.dataSources.remove(oilEventSource, true);
    oilEventSource = null;
  }

  const source = new Cesium.CustomDataSource("oilEvent");
  const { event, countries, framings } = oilMedia;
  const vienna = Cesium.Cartesian3.fromDegrees(event.lon, event.lat, 80000);

  // Point only — no Cesium label (Infinity disableDepthTestDistance broke stand smoke).
  source.entities.add({
    id: "opec-event",
    position: vienna,
    point: {
      pixelSize: 14,
      color: Cesium.Color.fromCssColorString("#f5f0e8"),
      outlineColor: Cesium.Color.fromCssColorString("#0c2c54"),
      outlineWidth: 3,
      heightReference: Cesium.HeightReference.NONE,
    },
    description: `${event.summary} Meeting place: ${event.place}.`,
  });

  countries.forEach((country, index) => {
    const color = framingColor(country.framing, framings);
    const bend = ((index % 5) - 2) * 0.45 + (index % 2 === 0 ? 0.2 : -0.2);
    const ring = ((index + 0.5) / countries.length) * Math.PI * 2;
    const endLon = event.lon + Math.cos(ring) * 1.35;
    const endLat = event.lat + Math.sin(ring) * 0.95;
    flowArcMeta.set(country.iso3, {
      lon1: country.lon,
      lat1: country.lat,
      lon2: endLon,
      lat2: endLat,
      bend,
    });
    const positions = curvedArc(country.lon, country.lat, endLon, endLat, { bend });
    const pickId = { flowId: country.iso3, country, framing: country.framing };

    // Primitives with depthMask:false — arcs never overwrite the stand depth used by smoke.
    const base = makeFlowPrimitive(positions, 2.2, solidMaterial(color, 0.2), pickId);
    const dash = makeFlowPrimitive(
      positions,
      4.4,
      dashMaterial(color, 0.95, country.framing),
      pickId,
    );
    oilFlowPrims.set(country.iso3, {
      country,
      framing: country.framing,
      base,
      dash,
      levitate: 0,
    });
  });

  oilEventSource = source;
  viewer.dataSources.add(source);
  viewer.scene.requestRenderMode = false;
  buildOilFilterUi();
  applyOilFilters();
}

async function showOilOverlay() {
  clearOilOverlay();
  if (selectedStyle.overlay !== "oil") return;

  const choropleth = await loadOilTile();
  if (selectedStyle.overlay !== "oil") return;
  oilChoroplethLayer = viewer.imageryLayers.addImageryProvider(choropleth);
  oilChoroplethLayer.alpha = 0.78;

  try {
    const labels = await loadPlaceLabels();
    if (selectedStyle.overlay !== "oil") return;
    oilLabelsLayer = viewer.imageryLayers.addImageryProvider(labels);
  } catch (error) {
    console.warn("Place labels overlay could not load; oil colours still shown.", error);
  }

  try {
    await showOilFlows();
  } catch (error) {
    console.error("Could not load OPEC+ media flows:", error);
  }

  if (oilLegend) {
    oilLegend.hidden = false;
    legendBuilt = false;
    buildOilLegendSvg();
    updateOilLegendLayout();
    if (legendEditMode?.checked) setLegendEditing(true);
  }
}

/** Sit the curved legend on the globe’s right limb (SVG circle cx/cy/r in viewBox). */
function globeScreenRadiusPx() {
  const canvas = viewer.canvas;
  const camera = viewer.scene.camera;
  const dist = Cesium.Cartesian3.magnitude(camera.positionWC);
  const r = typeof EARTH_RADIUS === "number" ? EARTH_RADIUS : 6378137;
  const ang = Math.asin(Math.min(1, r / Math.max(dist, r + 1)));
  const frustum = camera.frustum;
  if (frustum.fovy) {
    return (ang / (frustum.fovy / 2)) * (canvas.clientHeight / 2);
  }
  return Math.min(canvas.clientWidth, canvas.clientHeight) * 0.38;
}

// Labels in the gap between globe and heat. Words expose bend + XYZ rotation fields.
const DEFAULT_LEGEND_LAYOUT = {
  cx: 42,
  cy: 50,
  rGlobe: 38,
  inset: 0.99,
  offsetX: 36.21,
  offsetY: -2.12,
  parts: {
    trade: { r: 37.42, a0: -246.7, a1: -106.7, width: 1.35 },
    exporter: {
      r: 23.3,
      angle: -126,
      bend: 56.5,
      invertBend: true,
      flip: false,
      scale: 0.91,
      rotX: 2,
      rotY: 0,
      rotZ: 0,
      x: 1.83,
      y: -42.15,
      dy: 0,
      tracking: 0.12,
      span: 56.5,
    },
    importer: {
      r: 23.3,
      angle: -118,
      bend: 56.5,
      invertBend: true,
      flip: false,
      scale: 0.91,
      rotX: -11,
      rotY: 2,
      rotZ: 110,
      x: -104.78,
      y: -42.44,
      dy: 0,
      tracking: 0.12,
      span: 56.5,
    },
  },
};

let legendLayout = structuredClone(DEFAULT_LEGEND_LAYOUT);
let legendSelected = null;
let legendDrag = null;
let legendBuilt = false;
// Blender-style: G move · R rotate · S scale · F flip · B bend · X/Y/Z lock
let legendTool = "move";
let legendAxis = null;

const legendEditMode = document.getElementById("legendEditMode");
const legendEditBar = document.getElementById("legendEditBar");
const legendEditReadout = document.getElementById("legendEditReadout");
const legendEditShotHelp = document.getElementById("legendEditShotHelp");
const legendWordFields = document.getElementById("legendWordFields");
const oilLegendRoot = () => document.getElementById("oilLegendRoot");

const WORD_FIELDS = [
  { key: "x", label: "Pos X", min: -60, max: 60, step: 0.1 },
  { key: "y", label: "Pos Y", min: -60, max: 60, step: 0.1 },
  { key: "r", label: "Radius", min: 8, max: 60, step: 0.1 },
  { key: "angle", label: "Angle", min: -360, max: 360, step: 0.5 },
  { key: "bend", label: "Bend", min: 8, max: 90, step: 0.5 },
  { key: "scale", label: "Scale", min: 0.4, max: 3, step: 0.05 },
  { key: "rotX", label: "Rot X", min: -180, max: 180, step: 1 },
  { key: "rotY", label: "Rot Y", min: -180, max: 180, step: 1 },
  { key: "rotZ", label: "Rot Z", min: -180, max: 180, step: 1 },
  { key: "dy", label: "Baseline", min: -2, max: 2, step: 0.05 },
  { key: "tracking", label: "Tracking", min: 0, max: 0.5, step: 0.01 },
];

const TRADE_FIELDS = [
  { key: "r", label: "Radius", min: 8, max: 60, step: 0.1 },
  { key: "a0", label: "Start °", min: -360, max: 360, step: 0.5 },
  { key: "a1", label: "End °", min: -360, max: 360, step: 0.5 },
  { key: "width", label: "Width", min: 0.4, max: 4, step: 0.05 },
];

function deg(a) {
  return (a * Math.PI) / 180;
}

function polar(cx, cy, r, angleDeg) {
  return { x: cx + r * Math.cos(deg(angleDeg)), y: cy - r * Math.sin(deg(angleDeg)) };
}

function angleOf(cx, cy, x, y) {
  return (Math.atan2(cy - y, x - cx) * 180) / Math.PI;
}

function arcPath(cx, cy, r, a0, a1) {
  const p0 = polar(cx, cy, r, a0);
  const p1 = polar(cx, cy, r, a1);
  const mid = polar(cx, cy, r, (a0 + a1) / 2);
  const large = Math.abs(a1 - a0) > 180 ? 1 : 0;
  // Pick the sweep whose short arc passes near the intended mid (y-down SVG).
  const cross = (p1.x - p0.x) * (mid.y - p0.y) - (p1.y - p0.y) * (mid.x - p0.x);
  const sweep = cross > 0 ? 1 : 0;
  return `M ${p0.x.toFixed(2)},${p0.y.toFixed(2)} A ${r},${r} 0 ${large} ${sweep} ${p1.x.toFixed(2)},${p1.y.toFixed(2)}`;
}

/** Circular arc through 3 points (used so invertBend can bow the other way). */
function arcThroughThreePoints(p0, pMid, p1, reverse) {
  const ax = p0.x;
  const ay = p0.y;
  const bx = pMid.x;
  const by = pMid.y;
  const cx = p1.x;
  const cy = p1.y;
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-6) {
    return reverse
      ? `M ${p1.x.toFixed(2)},${p1.y.toFixed(2)} L ${p0.x.toFixed(2)},${p0.y.toFixed(2)}`
      : `M ${p0.x.toFixed(2)},${p0.y.toFixed(2)} L ${p1.x.toFixed(2)},${p1.y.toFixed(2)}`;
  }
  const ux =
    ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
  const uy =
    ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;
  const rad = Math.hypot(ax - ux, ay - uy);
  const cross = (pMid.x - p0.x) * (p1.y - p0.y) - (pMid.y - p0.y) * (p1.x - p0.x);
  const sweep = cross > 0 ? 1 : 0;
  if (reverse) {
    return `M ${p1.x.toFixed(2)},${p1.y.toFixed(2)} A ${rad.toFixed(2)},${rad.toFixed(2)} 0 0 ${1 - sweep} ${p0.x.toFixed(2)},${p0.y.toFixed(2)}`;
  }
  return `M ${p0.x.toFixed(2)},${p0.y.toFixed(2)} A ${rad.toFixed(2)},${rad.toFixed(2)} 0 0 ${sweep} ${p1.x.toFixed(2)},${p1.y.toFixed(2)}`;
}

/** Word curve along placement circle; invertBend mirrors the bulge the other way. */
function wordCurvePath(cx, cy, r, angle, bend, invertBend, flip) {
  const half = Math.abs(bend) / 2;
  const p0 = polar(cx, cy, r, angle - half);
  const p1 = polar(cx, cy, r, angle + half);
  const midOnCircle = polar(cx, cy, r, angle);
  const cmx = (p0.x + p1.x) / 2;
  const cmy = (p0.y + p1.y) / 2;
  let bx = midOnCircle.x - cmx;
  let by = midOnCircle.y - cmy;
  if (invertBend) {
    bx = -bx;
    by = -by;
  }
  const bulge = { x: cmx + bx, y: cmy + by };
  return arcThroughThreePoints(p0, bulge, p1, !!flip);
}

function svgEl(name, attrs = {}) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const [k, v] of Object.entries(attrs)) {
    if (v != null) el.setAttribute(k, String(v));
  }
  return el;
}

function roundLayout(value) {
  if (typeof value === "number") return Math.round(value * 100) / 100;
  if (value && typeof value === "object") {
    const out = Array.isArray(value) ? [] : {};
    for (const [k, v] of Object.entries(value)) out[k] = roundLayout(v);
    return out;
  }
  return value;
}

function updateLegendReadout() {
  if (!legendEditReadout) return;
  const axis = legendAxis ? ` · axis ${legendAxis.toUpperCase()}` : "";
  const tool = `tool: ${legendTool.toUpperCase()}${axis}  (G = Pos X/Y · R rotate · S scale · B bend · F flip · I invert)\n`;
  const selected = legendSelected ? `selected: ${legendSelected}\n` : "selected: (none) — click a word or the ramp\n";
  legendEditReadout.textContent = tool + selected + JSON.stringify(roundLayout(legendLayout), null, 2);
}

function flipSelectedLegendWord() {
  if (!legendSelected) return;
  const part = legendLayout.parts[legendSelected];
  if (!part || part.angle == null) return;
  part.flip = !part.flip;
  buildOilLegendSvg();
  syncLegendWordFields();
  updateLegendReadout();
}

function wordBend(part) {
  // bend is the curve amount; fall back to legacy span.
  return part.bend ?? part.span ?? 32;
}

function ensureWordDefaults(part) {
  if (part.angle == null) return part;
  if (part.bend == null && part.span != null) part.bend = part.span;
  if (part.bend == null) part.bend = 32;
  if (part.invertBend == null) part.invertBend = false;
  if (part.rotX == null) part.rotX = 0;
  if (part.rotY == null) part.rotY = 0;
  if (part.rotZ == null) part.rotZ = 0;
  if (part.x == null) part.x = 0;
  if (part.y == null) part.y = 0;
  if (part.dy == null) part.dy = 0;
  if (part.tracking == null) part.tracking = 0.12;
  if (part.scale == null) part.scale = 1;
  if (part.flip == null) part.flip = false;
  return part;
}

function invertSelectedLegendBend() {
  if (!legendSelected) return;
  const part = legendLayout.parts[legendSelected];
  if (!part || part.angle == null) return;
  ensureWordDefaults(part);
  part.invertBend = !part.invertBend;
  buildOilLegendSvg();
  if (legendWordFields) legendWordFields.dataset.for = "";
  syncLegendWordFields();
  updateLegendReadout();
}

function syncLegendWordFields() {
  if (!legendWordFields) return;
  const part = legendSelected ? legendLayout.parts[legendSelected] : null;
  if (!part) {
    legendWordFields.hidden = true;
    legendWordFields.replaceChildren();
    return;
  }
  legendWordFields.hidden = false;
  const isWord = part.angle != null;
  const fields = isWord ? WORD_FIELDS : TRADE_FIELDS;
  if (isWord) ensureWordDefaults(part);

  // Rebuild if schema changed / first paint.
  if (legendWordFields.dataset.for !== legendSelected) {
    legendWordFields.dataset.for = legendSelected;
    legendWordFields.replaceChildren();

    const title = document.createElement("p");
    title.style.margin = "4px 0 2px";
    title.style.color = "#ff9a1f";
    title.textContent = legendSelected;
    legendWordFields.appendChild(title);

    if (isWord) {
      const addToggle = (key, labelText) => {
        const row = document.createElement("label");
        row.className = "toggle-field";
        const box = document.createElement("input");
        box.type = "checkbox";
        box.dataset.key = key;
        box.checked = !!part[key];
        box.addEventListener("change", () => {
          part[key] = box.checked;
          buildOilLegendSvg();
          updateLegendReadout();
        });
        row.append(box, document.createTextNode(labelText));
        legendWordFields.appendChild(row);
      };
      addToggle("invertBend", "Invert bend (curve the other way)");
      addToggle("flip", "Flip (reading direction)");
    }

    for (const field of fields) {
      const row = document.createElement("label");
      row.className = "field";
      const name = document.createElement("span");
      name.textContent = field.label;
      const slider = document.createElement("input");
      slider.type = "range";
      slider.min = field.min;
      slider.max = field.max;
      slider.step = field.step;
      slider.dataset.key = field.key;
      const number = document.createElement("input");
      number.type = "number";
      number.min = field.min;
      number.max = field.max;
      number.step = field.step;
      number.dataset.key = field.key;

      const apply = (value) => {
        const v = Number(value);
        if (!Number.isFinite(v)) return;
        part[field.key] = v;
        if (field.key === "bend") part.span = v; // keep span in sync for older code paths
        buildOilLegendSvg();
        updateLegendReadout();
        slider.value = String(v);
        number.value = String(Math.round(v * 1000) / 1000);
      };
      slider.addEventListener("input", () => apply(slider.value));
      number.addEventListener("change", () => apply(number.value));
      row.append(name, slider, number);
      legendWordFields.appendChild(row);
    }
  }

  // Sync values into existing controls.
  legendWordFields.querySelectorAll("input[data-key]").forEach((input) => {
    const key = input.dataset.key;
    if (key === "flip" || key === "invertBend") {
      input.checked = !!part[key];
      return;
    }
    const raw = part[key];
    const v = key === "bend" ? wordBend(part) : raw;
    if (v == null) return;
    input.value = String(v);
  });
}

function highlightLegendSelection() {
  const root = oilLegendRoot();
  if (!root) return;
  root.querySelectorAll(".legend-part").forEach((g) => {
    g.classList.toggle("is-selected", g.dataset.part === legendSelected);
  });
}

function setLegendSelected(id) {
  const changed = legendSelected !== id;
  legendSelected = id;
  highlightLegendSelection();
  if (changed && legendWordFields) legendWordFields.dataset.for = "";
  syncLegendWordFields();
  updateLegendReadout();
}

function buildOilLegendSvg() {
  const root = oilLegendRoot();
  if (!root) return;
  const { cx, cy, parts } = legendLayout;
  const editing = document.body.classList.contains("legend-editing");
  root.replaceChildren();

  // --- Color ramp: soft underglow + thin core (less cartoon) ---
  const trade = parts.trade;
  const tradePath = arcPath(cx, cy, trade.r, trade.a0, trade.a1);
  const tradeMid = polar(cx, cy, trade.r, (trade.a0 + trade.a1) / 2);
  const tradeStart = polar(cx, cy, trade.r, trade.a0);
  const tradeEnd = polar(cx, cy, trade.r, trade.a1);
  const ramp = document.getElementById("oilTradeRamp");
  if (ramp) {
    // a0 → top/exporter end in this shot; flip so blue sits at importer (bottom / a1).
    ramp.setAttribute("x1", tradeEnd.x.toFixed(2));
    ramp.setAttribute("y1", tradeEnd.y.toFixed(2));
    ramp.setAttribute("x2", tradeStart.x.toFixed(2));
    ramp.setAttribute("y2", tradeStart.y.toFixed(2));
  }
  const tradeG = svgEl("g", { class: "legend-part", "data-part": "trade" });
  const tradeW = trade.width ?? 1.35;
  tradeG.appendChild(
    svgEl("path", {
      class: "trade-glow",
      d: tradePath,
      fill: "none",
      stroke: "url(#oilTradeRamp)",
      "stroke-width": tradeW * 2.4,
      "stroke-linecap": "round",
    }),
  );
  tradeG.appendChild(
    svgEl("path", {
      class: "trade-core",
      d: tradePath,
      fill: "none",
      stroke: "url(#oilTradeRamp)",
      "stroke-width": tradeW,
      "stroke-linecap": "round",
    }),
  );
  if (editing) {
    tradeG.appendChild(
      svgEl("path", {
        class: "legend-hit",
        d: tradePath,
        fill: "none",
        stroke: "transparent",
        "stroke-width": 7,
      }),
    );
    tradeG.appendChild(svgEl("circle", { class: "legend-handle", cx: tradeMid.x, cy: tradeMid.y, r: 1.8 }));
    const p0 = polar(cx, cy, trade.r, trade.a0);
    const p1 = polar(cx, cy, trade.r, trade.a1);
    tradeG.appendChild(svgEl("circle", { class: "legend-handle legend-end", "data-end": "a0", cx: p0.x, cy: p0.y, r: 1.4 }));
    tradeG.appendChild(svgEl("circle", { class: "legend-handle legend-end", "data-end": "a1", cx: p1.x, cy: p1.y, r: 1.4 }));
  }
  root.appendChild(tradeG);

  // --- Words curved under the heat (bend + XYZ rot + tracking) ---
  function addCurvedWord(id, text) {
    const raw = parts[id];
    if (!raw) return;
    const part = ensureWordDefaults(raw);
    const bend = wordBend(part);
    const d = wordCurvePath(cx, cy, part.r, part.angle, bend, !!part.invertBend, !!part.flip);
    const pathId = `legend-word-${id}`;
    const mid = polar(cx, cy, part.r, part.angle);
    // Visual mid of the bent path (bulge point) for handles when inverted.
    const half = Math.abs(bend) / 2;
    const p0 = polar(cx, cy, part.r, part.angle - half);
    const p1 = polar(cx, cy, part.r, part.angle + half);
    const cmx = (p0.x + p1.x) / 2;
    const cmy = (p0.y + p1.y) / 2;
    let bx = mid.x - cmx;
    let by = mid.y - cmy;
    if (part.invertBend) {
      bx = -bx;
      by = -by;
    }
    const handle = { x: cmx + bx, y: cmy + by };
    const ox = part.x ?? 0;
    const oy = part.y ?? 0;
    const g = svgEl("g", { class: "legend-part", "data-part": id });
    // Free X/Y displace — drag with G or scrub Pos X / Pos Y.
    g.setAttribute("transform", `translate(${ox}, ${oy})`);
    g.appendChild(svgEl("path", { id: pathId, d, fill: "none" }));

    // Pivot group at the word mid so rotX/Y/Z orbit the label.
    const xform = svgEl("g", { class: "legend-word-xform" });
    const rx = part.rotX ?? 0;
    const ry = part.rotY ?? 0;
    const rz = part.rotZ ?? 0;
    const pivot = handle;
    xform.style.transform = `translate(${pivot.x}px, ${pivot.y}px) rotateX(${rx}deg) rotateY(${ry}deg) rotateZ(${rz}deg) translate(${-pivot.x}px, ${-pivot.y}px)`;

    const label = svgEl("text", { class: "arc-caption" });
    const scale = part.scale ?? 1;
    label.style.fontSize = `${(2.45 * scale).toFixed(2)}px`;
    label.style.letterSpacing = `${part.tracking ?? 0.12}em`;
    const baseDy = part.flip ? 0.35 : -0.15;
    label.setAttribute("dy", `${(baseDy + (part.dy ?? 0)).toFixed(3)}em`);
    const tp = svgEl("textPath", {
      href: `#${pathId}`,
      startOffset: "50%",
      "text-anchor": "middle",
      method: "align",
      spacing: "auto",
    });
    // When bend is inverted, default glyph side often needs the opposite of flip.
    if (part.flip !== !!part.invertBend) tp.setAttribute("side", "right");
    tp.textContent = text.toUpperCase();
    label.appendChild(tp);
    xform.appendChild(label);
    g.appendChild(xform);

    if (editing) {
      g.appendChild(svgEl("path", { class: "legend-hit", d, fill: "none", stroke: "transparent", "stroke-width": 5 }));
      g.appendChild(svgEl("circle", { class: "legend-handle", cx: handle.x, cy: handle.y, r: 1.8 }));
      const sh = {
        x: handle.x + (handle.x - cx) * 0.08,
        y: handle.y + (handle.y - cy) * 0.08,
      };
      g.appendChild(
        svgEl("circle", {
          class: "legend-handle legend-scale",
          "data-scale": "1",
          cx: sh.x,
          cy: sh.y,
          r: 1.25,
        }),
      );
    }
    root.appendChild(g);
  }

  addCurvedWord("importer", "Importer");
  addCurvedWord("exporter", "Exporter");

  if (editing) {
    const g = svgEl("g", { class: "legend-part", "data-part": "origin" });
    g.appendChild(svgEl("circle", { class: "legend-handle", cx, cy, r: 2.2 }));
    root.appendChild(g);
  }

  if (legendSelected) {
    highlightLegendSelection();
    syncLegendWordFields();
  }
  updateLegendReadout();
  legendBuilt = true;
}

function clientToSvg(svg, clientX, clientY) {
  const pt = svg.createSVGPoint();
  pt.x = clientX;
  pt.y = clientY;
  const ctm = svg.getScreenCTM();
  if (!ctm) return { x: 0, y: 0 };
  const local = pt.matrixTransform(ctm.inverse());
  return { x: local.x, y: local.y };
}

function applyLegendPartDrag(drag, svgX, svgY) {
  const { cx, cy } = legendLayout;
  const id = drag.id;
  if (id === "origin") {
    const dx = svgX - drag.startSvg.x;
    const dy = svgY - drag.startSvg.y;
    legendLayout.offsetX = drag.startOffsetX + dx;
    legendLayout.offsetY = drag.startOffsetY + dy;
    updateOilLegendLayout();
    return;
  }

  const part = legendLayout.parts[id];
  if (!part) return;

  // Color line: mid-drag slides arc; end handles set a0/a1; Shift = radius only.
  if (id === "trade") {
    const r = Math.max(8, Math.hypot(svgX - cx, svgY - cy));
    const ang = angleOf(cx, cy, svgX, svgY);
    if (drag.end === "a0") {
      part.a0 = ang;
      if (!drag.radiusOnly) part.r = r;
      return;
    }
    if (drag.end === "a1") {
      part.a1 = ang;
      if (!drag.radiusOnly) part.r = r;
      return;
    }
    if (!drag.radiusOnly) {
      const span = part.a1 - part.a0;
      part.a0 = ang - span / 2;
      part.a1 = ang + span / 2;
    }
    part.r = r;
    return;
  }

  // Curved words — tool decides what the drag changes.
  if (part.angle != null) {
    ensureWordDefaults(part);
    const r = Math.max(8, Math.hypot(svgX - cx, svgY - cy));
    const ang = angleOf(cx, cy, svgX, svgY);
    const mode = drag.mode || legendTool;
    const dx = svgX - drag.startSvg.x;
    const dy = svgY - drag.startSvg.y;

    if (mode === "scale" || drag.scaleHandle) {
      const startDist = Math.hypot(drag.startSvg.x - cx, drag.startSvg.y - cy) || 1;
      const ratio = r / startDist;
      part.scale = Math.max(0.4, Math.min(3, (drag.startScale ?? 1) * ratio));
      return;
    }
    if (mode === "bend") {
      const startDist = Math.hypot(drag.startSvg.x - cx, drag.startSvg.y - cy) || 1;
      const ratio = r / startDist;
      part.bend = Math.max(8, Math.min(90, (drag.startBend ?? wordBend(part)) * ratio));
      part.span = part.bend;
      return;
    }
    if (mode === "rotate") {
      // XYZ rotation (Blender-style). Default Z; press X / Y / Z to lock an axis.
      const axis = drag.axis || legendAxis || "z";
      const sens = 0.6;
      if (axis === "x") {
        part.rotX = (drag.startRotX ?? 0) + dy * sens;
      } else if (axis === "y") {
        part.rotY = (drag.startRotY ?? 0) + dx * sens;
      } else {
        part.rotZ = (drag.startRotZ ?? 0) + dx * sens;
      }
      return;
    }
    // move (G): free X/Y displace. Shift+drag = polar radius only (shape).
    if (drag.radiusOnly) {
      part.r = r;
      return;
    }
    part.x = (drag.startPosX ?? 0) + dx;
    part.y = (drag.startPosY ?? 0) + dy;
  }
}

function updateOilLegendLayout() {
  if (!oilLegend || oilLegend.hidden) return;
  if (typeof objectScreenPosition !== "function") return;
  const origin = objectScreenPosition();
  const radius = globeScreenRadiusPx();
  const { cx, cy, rGlobe, inset, offsetX, offsetY } = legendLayout;
  // rGlobe is in viewBox units (0–100); convert to fraction so limb radius maps to screen.
  const size = (radius * inset) / (rGlobe / 100);
  oilLegend.style.width = `${size}px`;
  oilLegend.style.height = `${size}px`;
  oilLegend.style.left = `${origin.x - size * (cx / 100) + offsetX * (size / 100)}px`;
  oilLegend.style.top = `${origin.y - size * (cy / 100) + offsetY * (size / 100)}px`;
  if (!legendBuilt) buildOilLegendSvg();
}

function setLegendEditing(on) {
  document.body.classList.toggle("legend-editing", on);
  if (legendEditBar) legendEditBar.hidden = !on;
  if (legendEditShotHelp) legendEditShotHelp.hidden = !on;
  if (on && oilLegend && !oilLegend.hidden) {
    buildOilLegendSvg();
    updateLegendReadout();
  } else if (!on) {
    legendSelected = null;
    legendDrag = null;
    if (oilLegend && !oilLegend.hidden) buildOilLegendSvg();
  }
}

legendEditMode?.addEventListener("change", () => {
  if (legendEditMode.checked && selectedStyle.overlay !== "oil") {
    legendEditMode.checked = false;
    return;
  }
  setLegendEditing(legendEditMode.checked);
});

oilLegend?.addEventListener("pointerdown", (event) => {
  if (!document.body.classList.contains("legend-editing")) return;
  const partEl = event.target.closest?.("[data-part]");
  if (!partEl) return;
  event.preventDefault();
  event.stopPropagation();
  const id = partEl.dataset.part;
  const end = event.target.getAttribute?.("data-end") || null;
  const scaleHandle = event.target.classList?.contains("legend-scale");
  setLegendSelected(id);
  const svg = oilLegend.querySelector("svg");
  const local = clientToSvg(svg, event.clientX, event.clientY);
  const part = legendLayout.parts[id];
  let mode = legendTool;
  if (scaleHandle) mode = "scale";
  if (part?.angle != null) ensureWordDefaults(part);
  legendDrag = {
    id,
    end,
    mode,
    axis: legendAxis,
    scaleHandle,
    radiusOnly: event.shiftKey,
    pointerId: event.pointerId,
    startSvg: { ...local },
    startOffsetX: legendLayout.offsetX,
    startOffsetY: legendLayout.offsetY,
    startScale: part?.scale ?? 1,
    startBend: part ? wordBend(part) : 32,
    startR: part?.r,
    startAngle: part?.angle,
    startPosX: part?.x ?? 0,
    startPosY: part?.y ?? 0,
    startRotX: part?.rotX ?? 0,
    startRotY: part?.rotY ?? 0,
    startRotZ: part?.rotZ ?? 0,
  };
  oilLegend.setPointerCapture?.(event.pointerId);
  if (id === "trade") applyLegendPartDrag(legendDrag, local.x, local.y);
  buildOilLegendSvg();
});

oilLegend?.addEventListener("pointermove", (event) => {
  if (!legendDrag) return;
  const svg = oilLegend.querySelector("svg");
  const local = clientToSvg(svg, event.clientX, event.clientY);
  legendDrag.radiusOnly = event.shiftKey && legendDrag.mode === "move";
  legendDrag.axis = legendAxis;
  applyLegendPartDrag(legendDrag, local.x, local.y);
  if (legendDrag.id !== "origin") buildOilLegendSvg();
  syncLegendWordFields();
  updateLegendReadout();
});

function endLegendDrag() {
  legendDrag = null;
  syncLegendWordFields();
  updateLegendReadout();
}

oilLegend?.addEventListener("pointerup", endLegendDrag);
oilLegend?.addEventListener("pointercancel", endLegendDrag);

// Wheel: nudge bend of selected word.
oilLegend?.addEventListener(
  "wheel",
  (event) => {
    if (!document.body.classList.contains("legend-editing") || !legendSelected) return;
    const part = legendLayout.parts[legendSelected];
    if (!part || part.angle == null) return;
    event.preventDefault();
    event.stopPropagation();
    ensureWordDefaults(part);
    part.bend = Math.max(8, Math.min(90, wordBend(part) - event.deltaY * 0.04));
    part.span = part.bend;
    buildOilLegendSvg();
    syncLegendWordFields();
    updateLegendReadout();
  },
  { passive: false },
);

window.addEventListener("keydown", (event) => {
  if (!document.body.classList.contains("legend-editing")) return;
  const typing = event.target instanceof Element && event.target.matches("input, textarea");
  if (typing || event.ctrlKey || event.metaKey) return;
  const key = event.key.toLowerCase();
  if (key === "g") {
    legendTool = "move";
    legendAxis = null;
    updateLegendReadout();
    event.preventDefault();
  } else if (key === "r") {
    legendTool = "rotate";
    legendAxis = legendAxis || "z";
    updateLegendReadout();
    event.preventDefault();
  } else if (key === "s") {
    legendTool = "scale";
    legendAxis = null;
    updateLegendReadout();
    event.preventDefault();
  } else if (key === "b") {
    legendTool = "bend";
    legendAxis = null;
    updateLegendReadout();
    event.preventDefault();
  } else if (key === "f") {
    flipSelectedLegendWord();
    event.preventDefault();
  } else if (key === "i") {
    invertSelectedLegendBend();
    event.preventDefault();
  } else if (key === "x" || key === "y" || key === "z") {
    if (legendTool === "rotate") {
      legendAxis = legendAxis === key ? null : key;
      if (legendDrag) legendDrag.axis = legendAxis || "z";
      updateLegendReadout();
      event.preventDefault();
    }
  } else if (key === "escape") {
    legendTool = "move";
    legendAxis = null;
    legendSelected = null;
    legendDrag = null;
    if (legendWordFields) {
      legendWordFields.hidden = true;
      legendWordFields.dataset.for = "";
      legendWordFields.replaceChildren();
    }
    buildOilLegendSvg();
    updateLegendReadout();
  }
});

document.getElementById("invertLegendBend")?.addEventListener("click", () => {
  if (legendSelected && legendLayout.parts[legendSelected]?.angle != null) {
    invertSelectedLegendBend();
    return;
  }
  for (const id of ["importer", "exporter"]) {
    const p = legendLayout.parts[id];
    if (!p || p.angle == null) continue;
    ensureWordDefaults(p);
    p.invertBend = !p.invertBend;
  }
  buildOilLegendSvg();
  if (legendWordFields) legendWordFields.dataset.for = "";
  syncLegendWordFields();
  updateLegendReadout();
});

document.getElementById("flipLegendWord")?.addEventListener("click", () => {
  if (legendSelected && legendLayout.parts[legendSelected]?.angle != null) {
    flipSelectedLegendWord();
    return;
  }
  for (const id of ["importer", "exporter"]) {
    const p = legendLayout.parts[id];
    if (p) p.flip = !p.flip;
  }
  buildOilLegendSvg();
  if (legendWordFields) legendWordFields.dataset.for = "";
  syncLegendWordFields();
  updateLegendReadout();
});

document.getElementById("copyLegendLayout")?.addEventListener("click", async (event) => {
  const text = JSON.stringify(roundLayout(legendLayout), null, 2);
  try {
    await navigator.clipboard.writeText(text);
    event.currentTarget.textContent = "Copied!";
    setTimeout(() => (event.currentTarget.textContent = "Copy positions"), 1200);
  } catch (_) {
    legendEditReadout.textContent = text;
  }
});

document.getElementById("resetLegendLayout")?.addEventListener("click", () => {
  legendLayout = structuredClone(DEFAULT_LEGEND_LAYOUT);
  legendSelected = null;
  legendAxis = null;
  legendTool = "move";
  if (legendWordFields) {
    legendWordFields.hidden = true;
    legendWordFields.dataset.for = "";
    legendWordFields.replaceChildren();
  }
  buildOilLegendSvg();
  updateOilLegendLayout();
  updateLegendReadout();
});

viewer.scene.preRender.addEventListener(updateOilLegendLayout);
window.addEventListener("resize", updateOilLegendLayout);

async function applyMapStyle(style) {
  selectedStyle = style;
  buttons.forEach((b) => b.classList.toggle("active", b.textContent === style.name));

  if (style.overlay !== "oil") clearOilOverlay();

  let provider;
  try {
    provider = await Cesium.IonImageryProvider.fromAssetId(style.assetId);
  } catch (error) {
    console.error(`Could not load "${style.name}" (ion asset ${style.assetId}):`, error);
    return;
  }
  if (selectedStyle !== style) return;

  viewer.imageryLayers.removeAll();
  oilChoroplethLayer = null;
  oilLabelsLayer = null;
  viewer.imageryLayers.addImageryProvider(provider);

  if (style.overlay === "oil") {
    try {
      await showOilOverlay();
    } catch (error) {
      console.error("Could not load the oil trade overlay:", error);
    }
  }
}

for (const style of mapStyles) {
  const button = document.createElement("button");
  button.textContent = style.name;
  button.addEventListener("click", () => applyMapStyle(style));
  filters.appendChild(button);
  buttons.push(button);
}

viewer.screenSpaceEventHandler.setInputAction((click) => {
  if (selectedStyle.overlay !== "oil" || (!oilFlowPrims.size && !oilEventSource)) return;

  const picked = viewer.scene.pick(click.position);
  const id = picked?.id;

  // Flow primitive pick id is a plain object { flowId, country, framing }.
  if (id?.country) {
    showFlowDetail(id.country);
    return;
  }
  if (id?.id === "opec-event" || id === "opec-event") {
    hideOilDetail();
    return;
  }

  // Click on a choropleth country (imagery isn't pickable) → globe hit → ISO3 lookup.
  const ray = viewer.camera.getPickRay(click.position);
  const hit = ray && viewer.scene.globe.pick(ray, viewer.scene);
  if (hit) {
    const carto = Cesium.Cartographic.fromCartesian(hit);
    const lon = Cesium.Math.toDegrees(carto.longitude);
    const lat = Cesium.Math.toDegrees(carto.latitude);
    const trade = findTradeCountryAt(lon, lat);
    const media = trade && mediaCountryByIso3(trade.iso3);
    if (media) {
      showFlowDetail(media);
      return;
    }
  }

  hideOilDetail();
}, Cesium.ScreenSpaceEventType.LEFT_CLICK);

// × hides Map style / Sequences / Shot / Appearance until page refresh.
document.querySelectorAll("#rightPanels .panel-dismiss").forEach((btn) => {
  btn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const panel = btn.closest("[data-panel]");
    if (panel) panel.hidden = true;
  });
});

const storyPage = document.getElementById("storyPage");

function revealStoryPage() {
  if (!storyPage) return;
  storyPage.classList.remove("is-hidden");
  storyPage.setAttribute("aria-hidden", "false");
  requestAnimationFrame(() => {
    requestAnimationFrame(() => storyPage.classList.add("is-revealed"));
  });
}

setTimeout(revealStoryPage, 480);

// Interactive HTML charts inside the manga story page.
const lensCopy = {
  exposure:
    "Exposure: who imports or exports oil, and how dependent their economies are on it.",
  narratives: "Narratives: which frames appeared in the sampled coverage of the cut.",
  agreement: "Surprises: where coverage matches the hypothesis—and where exceptions demand a closer look.",
};

const shockCopy = {
  cut: "Cut: importers emphasize affordability; exporters emphasize stability.",
  disrupt: "Disruption: dependence on affected suppliers predicts emphasis on energy insecurity.",
  price: "Price fall: oil-dependent economies stress revenue loss; importers stress consumer relief.",
};

const flowCopy = {
  trade: "Oil trade position sets the baseline economic stake in a shock.",
  depend: "Dependence amplifies how loudly a shock shows up in local coverage.",
  ties: "Supplier relationships decide whose crisis becomes your headline.",
  frames: "Estimated likelihood of news frames—geography is context, not destiny.",
};

const balanceCopy = {
  export: "Net exporters in the sample—often closer on framing than on the map.",
  import: "Net importers in the sample—watch affordability and security frames.",
};

document.querySelectorAll("#storyViews button").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#storyViews button").forEach((el) => {
      el.classList.toggle("is-active", el === btn);
    });
    const readout = document.getElementById("lensReadout");
    if (readout) readout.textContent = lensCopy[btn.dataset.view] ?? lensCopy.exposure;
  });
});

document.querySelectorAll("#lensBars .hbar").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#lensBars .hbar").forEach((el) => {
      el.classList.toggle("is-active", el === btn);
    });
  });
});

document.querySelectorAll(".top-metrics .hbar[data-balance]").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".top-metrics .hbar[data-balance]").forEach((el) => {
      el.classList.toggle("is-active", el === btn);
    });
    const readout = document.getElementById("balanceReadout");
    if (readout) readout.textContent = balanceCopy[btn.dataset.balance] ?? balanceCopy.export;
  });
});

document.querySelectorAll("#shockBars .vbar").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#shockBars .vbar").forEach((el) => {
      el.classList.toggle("is-active", el === btn);
    });
    const readout = document.getElementById("shockReadout");
    if (readout) readout.textContent = shockCopy[btn.dataset.shock] ?? shockCopy.cut;
  });
});

document.querySelectorAll("#flowSteps button").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#flowSteps button").forEach((el) => {
      el.classList.toggle("is-active", el === btn);
    });
    const readout = document.getElementById("flowReadout");
    if (readout) readout.textContent = flowCopy[btn.dataset.step] ?? flowCopy.trade;
  });
});

const frameFlex = { supportive: 32, critical: 48, mixed: 20 };
const frameOn = { supportive: true, critical: true, mixed: true };

function refreshFrameStack() {
  const stack = document.getElementById("frameStack");
  if (!stack) return;
  stack.querySelectorAll("[data-frame]").forEach((seg) => {
    const key = seg.dataset.frame;
    const on = frameOn[key];
    seg.style.flex = on ? String(frameFlex[key]) : "0";
    seg.style.opacity = on ? "1" : "0";
  });
}

document.querySelectorAll("#frameLegend button").forEach((btn) => {
  btn.addEventListener("click", () => {
    const key = btn.dataset.frame;
    frameOn[key] = !frameOn[key];
    btn.classList.toggle("is-dim", !frameOn[key]);
    btn.classList.toggle("is-on", frameOn[key]);
    refreshFrameStack();
  });
});

// Left HUD: stop spinning (mirrors Shot → Spin globe) + comprehensive oil filters.
const idleSpinToggleEl = document.getElementById("idleSpin");
const stopSpinningEl = document.getElementById("stopSpinning");
const filterToggleEl = document.getElementById("filterToggle");
const oilFilterPanelEl = document.getElementById("oilFilterPanel");

function syncStopSpinningFromIdle() {
  if (stopSpinningEl && idleSpinToggleEl) {
    stopSpinningEl.checked = !idleSpinToggleEl.checked;
  }
}

stopSpinningEl?.addEventListener("change", () => {
  if (idleSpinToggleEl) idleSpinToggleEl.checked = !stopSpinningEl.checked;
});
idleSpinToggleEl?.addEventListener("change", syncStopSpinningFromIdle);
syncStopSpinningFromIdle();

filterToggleEl?.addEventListener("click", () => {
  if (!oilFilterPanelEl) return;
  const open = oilFilterPanelEl.hidden;
  oilFilterPanelEl.hidden = !open;
  filterToggleEl.setAttribute("aria-expanded", open ? "true" : "false");
  if (open && oilMedia) buildOilFilterUi();
  applyOilFilters();
});

document.getElementById("oilFilterClear")?.addEventListener("click", resetOilFilters);

document.getElementById("oilFilterSearch")?.addEventListener("input", (event) => {
  oilFilter.search = event.target.value;
  applyOilFilters();
});

document.querySelectorAll('input[name="oilTradeRole"]').forEach((input) => {
  input.addEventListener("change", () => {
    if (input.checked) {
      oilFilter.tradeRole = input.value;
      applyOilFilters();
    }
  });
});

document.getElementById("oilArticlesMin")?.addEventListener("input", (event) => {
  oilFilter.articlesMin = Number(event.target.value);
  const out = document.getElementById("oilArticlesOut");
  if (out) out.textContent = `Min articles: ${oilFilter.articlesMin}`;
  applyOilFilters();
});

document.getElementById("oilOutletsMin")?.addEventListener("input", (event) => {
  oilFilter.outletsMin = Number(event.target.value);
  const out = document.getElementById("oilOutletsOut");
  if (out) out.textContent = `Min outlets: ${oilFilter.outletsMin}`;
  applyOilFilters();
});

for (const [id, key] of [
  ["oilLayerFlows", "flows"],
  ["oilLayerHeat", "heat"],
  ["oilLayerLabels", "labels"],
  ["oilLayerEvent", "event"],
]) {
  document.getElementById(id)?.addEventListener("change", (event) => {
    oilFilter.layers[key] = event.target.checked;
    applyOilFilters();
  });
}

document.getElementById("oilCountriesAll")?.addEventListener("click", () => {
  oilFilter.countries = null;
  applyOilFilters();
});

document.getElementById("oilCountriesNone")?.addEventListener("click", () => {
  oilFilter.countries = new Set();
  applyOilFilters();
});

applyMapStyle(selectedStyle);
