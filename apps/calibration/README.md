# Calibration

Built-in GOSAI app that runs the built-in calibration kinds for other apps.
It owns no calibration itself: GOSAI opens it for an app whose manifest
declares a built-in kind, and it saves that app's calibration profile.

| Experience  | Purpose                                               |
| ----------- | ----------------------------------------------------- |
| `calibrate` | Runs the `camera-projector-surface` flow for a target |

Electron main (the dashboard's **Calibrate** button, or a kiosk on first boot)
starts the experience and opens two windows:

- a control window on the dashboard display, with `role=control`,
- a fullscreen projector window on the target app's display, with
  `role=projector`.

Both get `target=<app slug>`. The drivers run under the target app's binding,
so the flow uses the target's camera and camera settings, while the runner's
storage and events stay its own. When the flow ends, the control window
broadcasts `wizard:finished` with `{ ok: true }` or `{ ok: false, error }`, and
main closes both windows. A window that can't load its target reports the
failure the same way.

When the target's camera has a manual-focus control (V4L2 `focus_absolute`),
the control window's footer offers Auto or Manual focus. Drag the slider while
watching the feed to pin the focus, which stops autofocus from hunting on a
flat surface such as a pool table. The value is saved to the target app's
camera settings and applied whenever that app opens the camera. This is why the
runner requests `app-config:write`, which reaches only its launch target.

## Target app contract

An app opts in from `gosai.app.json`:

```jsonc
"calibration": {
  "kind": "camera-projector-surface",
  "required": true, // calibrate before the app starts
  "options": {
    "surfaceSize": { "width": 1920, "height": 1080 },
    "cornerLabels": ["TL", "TR", "BR", "BL"],
    "stepCopy": { "surface-corners": { "title": "Pool corners", "help": "…" } },
    "projectorMessages": { "surfaceCorners": "pick the corners on the control window" }
  }
}
```

`stepCopy` keys are the steps `markers`, `surface-corners`, `compute` and
`preview`. `projectorMessages` has `surfaceCorners`, `compute`, `done` and
`cancelled`.

The app reads the result with `loadCameraProjectorSurfaceCalibration(rt)` from
`@gosai/sdk`, which returns `null` until the app is calibrated.

## Flow

1. **Markers**: the projector draws nine ArUco markers. Pan them with the arrow
   keys and zoom with the wheel in the control window until they cover the
   surface.
2. **Surface corners**: click the four corners of the surface in the camera
   image, top-left first, clockwise.
3. **Compute**: the `calibration` driver fits the camera to display homography
   from the markers and the camera to surface homography from the corners. A
   failure, such as too few markers, goes back to the corners with the error.
4. **Preview**: the projector shows the camera feed warped onto the surface.
   Back returns to the corners; Done saves the profile.

## Profile

The runner saves one `camera-projector-surface` profile with the
`calibration:save` command, which its manifest's `calibration:write`
capability allows for the target app only. The profile's data:

| Field                                           | Type                                    |
| ----------------------------------------------- | --------------------------------------- |
| `homography`, `homographyInverse`               | `number[9]` row-major, camera ↔ display |
| `homographySurface`, `homographySurfaceInverse` | `number[9]` or `null`, camera ↔ surface |
| `focusQuad`                                     | 4 corners in normalised camera coords   |
| `surfaceQuadDisplay`                            | 4 corners in display pixels             |
| `surfaceSize`, `frameSize`                      | `{ width, height }`                     |

Apps calibrated before profiles existed kept nine separate storage keys. The
server converts them into a profile the first time it reads the app's
calibration.

## Driver dependencies

- `camera`: provides frames.
- `calibration`: detects ArUco markers and computes the homographies. It
  depends on `camera`.

## Development

```bash
bun run build
bun test
```

GOSAI loads the output from `apps/calibration/dist/` on the app's own origin.
