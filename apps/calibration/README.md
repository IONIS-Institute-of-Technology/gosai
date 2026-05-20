# Calibration

Built-in GOSAI app that handles camera/projector calibration and shared
spatial primitives used by other AR apps.

This app is shipped inside the GOSAI server (no install step) and exposes a
single end-to-end wizard experience:

| Experience  | Purpose                                                                    |
| ----------- | -------------------------------------------------------------------------- |
| `calibrate` | Full wizard: markers → pool corners → compute → background → preview.      |

The wizard is launched from the **Calibrate** button in the Apps panel of the
GOSAI dashboard. It opens two windows simultaneously:

- A **projector window** (fullscreen) that displays ArUco markers, the black
  background frame during capture, and the live preview overlay.
- A **control window** (non-fullscreen, on the dashboard's display) that
  shows the camera feed, lets the user click the four pool corners, and
  drives the step machine.

The dashboard hides the control window automatically during the background
capture step so the camera does not see the control UI.

## Wizard steps

1. **markers** – ArUco grid projected. Aim the camera so all markers are
   detected (count shown in the control window).
2. **pool-corners** – Click the four pool / table corners on the camera image.
3. **compute** – Server computes the camera→display homography.
4. **background** – Control window hides briefly; an empty reference frame
   is captured and stored for the `ball` driver and other background
   subtractors.
5. **preview** – Live verification overlay. Press *Done* to finish.

Keyboard shortcuts in the control window: **Space/Enter** to advance,
**Backspace** to revert, **Esc** to abort, **r** to reset corners.

## Storage keys

All calibration outputs are persisted in this app's storage namespace so
other apps and drivers can read them back through the GOSAI server.

| Key                 | Type                       | Source step      |
| ------------------- | -------------------------- | ---------------- |
| `homography`        | `number[9]` (row-major)    | `compute`        |
| `markers_layout`    | `MarkerSlot[]`             | `markers`        |
| `focus_quad`        | `{ points: Point2D[4] }`   | `pool-corners`   |
| `background_jpeg`   | base64 JPEG string         | `background`     |

## Driver dependencies

- `camera`: provides raw frames (`color`, `frame_size`, `fps` events).
- `calibration`: detects ArUco markers, computes the homography, and exposes
  the `capture_background` action used by the background step.

The `calibration` driver depends on `camera`, so launching the wizard
automatically starts both.

## Development

```bash
bun install
bun run build
```

The output is loaded by GOSAI directly from `apps/calibration/dist/` via the
server's static asset route.
