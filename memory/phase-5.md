# Phase 5 - Built-in Calibration App

## Goal

Re-implement the legacy calibration workflows (camera↔projector homography,
focus quad picking, background reference capture, preview) as a first-class
GOSAI app that ships with the server and exercises the SDK + Python driver
surface end-to-end.

## What landed

### Python drivers

- `python/src/gosai_py/drivers/camera.py` - new `CameraDriver`:
  - Uses OpenCV (`opencv-contrib-python`, installed via the `cv` extra).
  - Emits `color` (base64 JPEG), `frame_size`, `fps` events.
  - Actions: `set_device`, `set_resolution`, `set_fps`, `snapshot`.
  - JPEG quality + downscale are tuneable via constants; default
    `JPEG_QUALITY=80`.

- `python/src/gosai_py/drivers/calibration.py` - new `CalibrationDriver`:
  - Subscribes to `camera.color` via the SDK's processor pattern (declares
    `camera` as a dependency).
  - Detects ArUco markers (`cv2.aruco.DICT_4X4_50`).
  - Emits `detection` (per frame), `homography` (after `compute`),
    `status` (lifecycle hints).
  - Actions:
    - `set_marker_layout(MarkerSlot[])` - TS-side layout, [{id, x, y, size}].
    - `set_camera_event(name)` - alternative camera channel (default `color`).
    - `compute()` - runs `cv2.findHomography` against the last detection.
    - `clear()` - drops in-memory state.
    - `render_marker({id, size})` - returns `{ ok, png_base64 }` for direct
      DOM rendering (no extra HTTP/static asset needed).
  - Uses `contextlib.suppress` instead of bare `try/except/pass`.

### Calibration app (`apps/calibration/`)

- `gosai.app.json`: marks the app `builtin: true`, lists four experiences.
- `src/shared.ts`: shared types (`Point2D`, `FocusQuad`, `MarkerSlot`) and
  helpers (`makeMarkerLayout`, `setBodyFullscreen`, `STORAGE_KEYS`).
- `src/camera-display.ts`: renders ArUco markers using `render_marker`,
  sends the layout to the driver, listens for `detection` + `homography`,
  persists `homography` and `markers_layout` to app storage.
- `src/display-focus.ts`: 4-corner picker with click + keyboard, persists
  `focus_quad`.
- `src/background-capture.ts`: subscribes to `camera.color`, stores the
  latest JPEG as `background_jpeg` on demand.
- `src/preview.ts`: renders the live camera + focus quad overlay using the
  SDK's per-frame `render` hook.

The package builds with `bun build` directly to `dist/` and the server's
static-asset route serves the resulting `.js` files to the app-host.

### Server integration

- `packages/shared/src/types.ts`: `DriverInfo` now carries `actions` and
  an optional `description` so the UI / clients know what an experience can
  ask a driver to do.
- `packages/server/src/drivers/manager.ts`: surfaces the extra fields from
  the Python manifest in the broadcasted driver list.

### Tests

- `packages/server/test/phase5-e2e.ts`: end-to-end smoke that boots the
  server with the workspace's real `apps/` directory, verifies the
  calibration app is discovered as built-in, checks both drivers register
  (with the expected events/actions/dependencies), exercises the
  `render_marker` driver action over WebSocket, performs a storage round
  trip via REST, and pulls the built `camera-display.js` through the
  server's static route. Passes locally.

## Key design choices

- **Markers as PNGs via driver action.** Instead of shipping marker images
  in the bundle or routing through static assets, the driver renders them
  on demand via OpenCV. This keeps the dictionary, marker IDs, and image
  sizing logic in one place and lets the TS experience stay layout-only.

- **Storage as the single source of truth.** All calibration outputs go
  through `rt.storage.set(...)`. Other GOSAI apps (e.g. the future ball
  driver) read them back via the same per-app storage REST endpoints, so
  there's no in-memory coupling.

- **`set_marker_layout` instead of static metadata.** Layout is decided at
  runtime by the TS side (display size, devicePixelRatio, etc.), then
  pushed to the driver before `compute()`. This avoids hard-coding
  resolution-specific positions in Python.

- **`render` lifecycle for preview only.** Experiences that don't need a
  redraw every frame (the picker and background capture) skip `render`
  entirely to save CPU; only `preview` opts in.

## Caveats / follow-ups

- Calibration depends on a real webcam being available. Without one, the
  driver starts cleanly but never emits frames; the e2e test reflects this
  by only validating action-style RPCs rather than a real compute.
- `display-focus` currently saves the quad in CSS pixels (matches the
  legacy semantics). When we add real coordinate transforms in Phase 6
  we'll likely want to also save device-pixel coordinates.
- `render_marker` returns base64 PNG over JSON. For very large markers this
  is wasteful. Once we have MessagePack-over-WS plumbing in Phase 6 we can
  switch to binary frames.
