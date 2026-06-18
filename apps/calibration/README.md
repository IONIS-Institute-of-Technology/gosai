# Calibration

Built-in GOSAI calibration runner. It does not own a calibration profile itself:
the dashboard launches it for a target app, the runner imports that app's
`calibration.entry` module, and successful calibration data is written to the
target app's own storage.

| Experience  | Purpose                                      |
| ----------- | -------------------------------------------- |
| `calibrate` | Runs the target app's calibration definition |

The runner opens two windows simultaneously:

- A projector window on the target app's assigned display.
- A control window on the dashboard display.

## Target App Contract

Apps opt in from `gosai.app.json`:

```jsonc
"calibration": {
  "required": true,
  "entry": "dist/calibration.js",
  "statusKey": "calibration_status"
}
```

The entry is a browser ESM module exporting a calibration definition. For the
standard camera/projector surface flow, apps can use the SDK helper:

```ts
import { createCameraProjectorSurfaceCalibration } from '@gosai/sdk';

export default createCameraProjectorSurfaceCalibration({
  name: 'Surface Calibration',
  surfaceSize: { width: 1920, height: 1080 },
});
```

## Standard Storage Keys

The camera/projector surface helper writes these keys to the target app:

| Key                                      | Type                     |
| ---------------------------------------- | ------------------------ |
| `calibration_status`                     | completion status object |
| `calibration_homography`                 | `number[9]` row-major    |
| `calibration_homography_inverse`         | `number[9]` row-major    |
| `calibration_homography_surface`         | `number[9]` row-major    |
| `calibration_homography_surface_inverse` | `number[9]` row-major    |
| `calibration_focus_quad`                 | `{ points: Point2D[4] }` |
| `calibration_surface_quad_display`       | `{ points: Point2D[4] }` |
| `calibration_surface_size`               | `{ width, height }`      |
| `calibration_frame_size`                 | `{ width, height }`      |

## Driver Dependencies

- `camera`: provides raw frames.
- `calibration`: detects ArUco markers and computes homographies.

The `calibration` driver depends on `camera`, so launching the runner starts
both drivers for the calibration app.

## Development

```bash
bun install
bun run build
```

The output is loaded by GOSAI from `apps/calibration/dist/` through the server's
static asset route.
