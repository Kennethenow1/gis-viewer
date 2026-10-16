# Things to look for

## Holder smoke mask relies on a private Cesium field

**Where:** `renderFrustum()` in `appearance.js`

To decode the depth image correctly, the smoke effect needs the near and far planes Cesium actually rendered the frame with. Cesium doesn't officially expose those, so the code reads an internal field:

```js
viewer.scene._view.frustumCommandsList
```

If you upgrade Cesium someday and the smoke mask breaks, this is the first place to look.

**Note:** `index.html` loads Cesium from `cesium@1` on the CDN, which automatically picks up every new 1.x release. An "upgrade" can therefore happen without you changing anything. To stop that, pin an exact version in the two Cesium URLs and in `CESIUM_BASE_URL` (for example `cesium@1.134` instead of `cesium@1`).

**Symptoms that point here:**
- The smoke covers the Earth as well as the holder.
- The smoke form disappears completely.
- With Holder at 0, the real wooden holder shows again.

**How it fails:** if the field is missing, the code falls back to `viewer.camera.frustum.near/far`. Those are only the camera's outer bounds, so the depth decodes wrongly.
