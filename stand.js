// stand.gltf is the antique globe stand re-centred on the pivot between its pins, with the
// spin axis on glTF +Y and the (removed) ball radius normalised to 1.
const EARTH_RADIUS = 6378137;
const AXIS_TILT = Cesium.Math.toRadians(25);
// Model-space directions (after Cesium's Y-up to Z-up conversion): the stand's upright
// direction, which is 25° off the spin axis, and the side of the stand that faces the viewer.
const STAND_UP = new Cesium.Cartesian3(-Math.sin(AXIS_TILT), 0, Math.cos(AXIS_TILT));
const STAND_FRONT = new Cesium.Cartesian3(0, 1, 0);
const STAND_RIGHT = Cesium.Cartesian3.cross(STAND_UP, STAND_FRONT, new Cesium.Cartesian3());
// Zoom 0..100 maps logarithmically to the camera's height above the globe, in Earth radii.
const FAR_ALTITUDE = 12;
const NEAR_ALTITUDE = 0.0003;

const scene = viewer.scene;
const camera = viewer.camera;
// The shot (see transform.js) decides the camera, so Cesium's own mouse navigation is off.
scene.screenSpaceCameraController.enableInputs = false;
// When new globe tiles load, collision can shove the camera for a frame — that reads as the Earth jumping.
scene.screenSpaceCameraController.enableCollisionDetection = false;
// Prefetch neighbouring tiles and keep a large cache so the sequence path stays sharp.
scene.globe.preloadAncestors = true;
scene.globe.preloadSiblings = true;
scene.globe.tileCacheSize = 2000;
// Oil flow arcs expand the scene depth range; keep one log-depth frustum so the stand
// smoke mask (post-process depth) isn't cleared between frustums.
scene.logarithmicDepthBuffer = true;
scene.logarithmicDepthFarToNearRatio = 1e12;

const light = new Cesium.DirectionalLight({ direction: new Cesium.Cartesian3(0, 0, -1), intensity: 2.5 });
scene.light = light;

let stand;
let resolveStandReady;
const standReady = new Promise((resolve) => (resolveStandReady = resolve));
Cesium.Model.fromGltfAsync({ url: "models/antique-globe/stand.gltf", forwardAxis: Cesium.Axis.X })
  .then((model) => {
    stand = scene.primitives.add(model);
    resolveStandReady(model);
  })
  .catch((error) => {
    console.error("Could not load the antique globe stand:", error);
    resolveStandReady(null);
  });

function zoomToAltitude(zoom) {
  return FAR_ALTITUDE * (NEAR_ALTITUDE / FAR_ALTITUDE) ** (zoom / 100);
}

function altitudeToZoom(altitude) {
  return (100 * Math.log(altitude / FAR_ALTITUDE)) / Math.log(NEAR_ALTITUDE / FAR_ALTITUDE);
}

// Rows map stand coordinates to view coordinates (x right, y up, z toward the viewer) at rest.
const standToView = Cesium.Matrix3.fromRowMajorArray([
  STAND_RIGHT.x, STAND_RIGHT.y, STAND_RIGHT.z,
  STAND_UP.x, STAND_UP.y, STAND_UP.z,
  STAND_FRONT.x, STAND_FRONT.y, STAND_FRONT.z,
]);
const spin = new Cesium.Matrix3();
const objectRotation = new Cesium.Matrix3();
const axisRotation = new Cesium.Matrix3();
const viewToWorld = new Cesium.Matrix3();
const standMatrix = new Cesium.Matrix4();
const shotOffset = new Cesium.Cartesian3();
const shotPosition = new Cesium.Cartesian3();
const shotDirection = new Cesium.Cartesian3();
const shotUp = new Cesium.Cartesian3();
const shotRight = new Cesium.Cartesian3();

// Places the camera so the globe + stand sit at shot.x/shot.y (percent of half the screen,
// +y up) with the given Blender-style XYZ Euler rotation, and the Earth turned inside the
// stand so the point at (shot.tilt, shot.longitude) faces the front.
function applyShot(shot) {
  const toRadians = Cesium.Math.toRadians;
  Cesium.Matrix3.fromRotationZ(toRadians(shot.longitude - 90), spin);
  Cesium.Matrix3.multiply(spin, Cesium.Matrix3.fromRotationX(toRadians(shot.tilt), axisRotation), spin);
  Cesium.Matrix3.fromRotationZ(toRadians(shot.rotZ), objectRotation);
  Cesium.Matrix3.multiply(objectRotation, Cesium.Matrix3.fromRotationY(toRadians(shot.rotY), axisRotation), objectRotation);
  Cesium.Matrix3.multiply(objectRotation, Cesium.Matrix3.fromRotationX(toRadians(shot.rotX), axisRotation), objectRotation);
  Cesium.Matrix3.multiply(objectRotation, standToView, objectRotation);
  Cesium.Matrix3.multiply(spin, Cesium.Matrix3.transpose(objectRotation, viewToWorld), viewToWorld);

  const distance = 1 + zoomToAltitude(shot.zoom);
  const tanY = Math.tan(camera.frustum.fovy / 2);
  const tanX = tanY * camera.frustum.aspectRatio;
  Cesium.Cartesian3.fromElements((-shot.x / 100) * distance * tanX, (-shot.y / 100) * distance * tanY, distance, shotOffset);
  Cesium.Matrix3.multiplyByVector(viewToWorld, shotOffset, shotPosition);
  Cesium.Cartesian3.multiplyByScalar(shotPosition, EARTH_RADIUS, shotPosition);
  Cesium.Matrix3.getColumn(viewToWorld, 2, shotDirection);
  Cesium.Cartesian3.negate(shotDirection, shotDirection);
  Cesium.Matrix3.getColumn(viewToWorld, 1, shotUp);
  Cesium.Matrix3.getColumn(viewToWorld, 0, shotRight);
  // Write the pose directly. camera.setView() can trigger controller/tiling side effects mid-sequence.
  Cesium.Cartesian3.clone(shotPosition, camera.position);
  Cesium.Cartesian3.clone(shotDirection, camera.direction);
  Cesium.Cartesian3.clone(shotUp, camera.up);
  Cesium.Cartesian3.clone(shotRight, camera.right);

  if (stand) {
    Cesium.Matrix4.fromRotation(spin, standMatrix);
    Cesium.Matrix4.multiplyByUniformScale(standMatrix, EARTH_RADIUS, standMatrix);
    stand.modelMatrix = standMatrix;
  }

  // Light from the upper left, behind the viewer.
  const lightDirection = Cesium.Cartesian3.clone(shotDirection, light.direction);
  Cesium.Cartesian3.add(lightDirection, Cesium.Cartesian3.multiplyByScalar(shotRight, 0.4, shotOffset), lightDirection);
  Cesium.Cartesian3.subtract(lightDirection, Cesium.Cartesian3.multiplyByScalar(shotUp, 0.6, shotOffset), lightDirection);
  Cesium.Cartesian3.normalize(lightDirection, lightDirection);
}
