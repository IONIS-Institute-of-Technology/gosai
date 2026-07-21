# Second Self

Augmented-mirror experience pack for GOSAI v2. A webcam tracks the user; the
app projects interactive overlays onto a **portrait** mirror display (reference
space `1080x1920`) so that on-screen graphics line up with the user's
reflection.

This is a clean, type-safe port of the legacy `second-self` app pack. Where the
legacy version was many separate p5.js apps coordinated over Socket.IO, this is
a **single composited experience**: one fullscreen canvas, one driver feed, and
internal **layers** (one per legacy experience) toggled by an in-process menu
controller (mirrors the [interactive-pool](../interactive-pool) architecture).

## Experiences (layers)

| Layer            | What it does                                                             |
| ---------------- | ------------------------------------------------------------------------ |
| `menu`           | Gesture-driven launcher (dwell-select bubbles), opens every other layer  |
| `hands`          | 21-point hand skeleton overlay                                           |
| `body`           | 33-point body skeleton overlay                                           |
| `face`           | Face-mesh wireframe overlay                                              |
| `clock`          | Analog clock overlay                                                     |
| `poke-it`        | Poke floating balls with your index fingertip                            |
| `bounce`         | Keep falling balls up with your hands (gravity + rebound)                |
| `show-frequency` | Live microphone FFT visualizer                                           |
| `show-ping`      | WebSocket round-trip latency display                                     |
| `theremine`      | Hand-controlled theremin (Web Audio synthesis)                           |
| `music-training` | Pitch trainer + falling-note tutorials for scores                        |
| `dance`          | Follow a reference dance, scored against `body_pose`                     |
| `sign-game`      | Sign-language visual novel (script-driven, choices made by signing)      |
| `sign-training`  | Guided sign tutor: mimic a reference video, then trace a correction pose |
| `aria`           | VRM avatar puppeted by your pose/hands/face (three.js + Kalidokit)       |

The menu controller enforces per-layer `exclusive` / `allowed` / `required`
relationships (ported from the legacy `processing.py` app-manager rules) and
per-layer options (the old `sub-menu.json` toggles become in-process options).

## Drivers used

| Driver               | Why                                                           |
| -------------------- | ------------------------------------------------------------- |
| `pose`               | MediaPipe Holistic landmarks (2D + metric 3D world landmarks); `raw_data` feeds aria directly |
| `pose_to_mirror`     | Projects landmarks into mirror pixel space (`mirrored_data`)  |
| `frequency_analysis` | Microphone pitch/amplitude/FFT (`frequency`)                  |
| `slr`                | Sign-language recognition over a 30-frame window (`new_sign`) |

`pose_to_mirror` and `slr` are **new built-in drivers** added to `gosai/python`
for this app (the legacy platform had them; the new one did not). They are
webcam-only — there is no RealSense dependency. See
[`python/src/gosai_py/drivers/README.md`](../../python/src/gosai_py/drivers/README.md)
for driver notes, and the docstrings in `pose_to_mirror.py` / `slr.py`.

Audio synthesis (the legacy `synthesizer` driver) is done **in-browser** via the
Web Audio API in `src/shared/synth.ts` — no Python round-trip.

## Architecture

```
webcam ─▶ pose ─┬─▶ pose_to_mirror ─(mirrored_data)─┐
                ├─▶ slr ─────────────(new_sign)──────┤
                └────────────────────(raw_data)──────┤  (aria only)
mic ────────────▶ frequency_analysis (frequency)─────┤
                                                      ▼
                                            main.ts compositor + feed
                                                      │
                                              MenuController
                                                      │
                                   layers ──▶ 1080x1920 portrait canvas
                                   theremine/music ──▶ shared/synth.ts (Web Audio)
                                   aria ──▶ own transparent WebGL canvas
```

- `src/main.ts` — compositor: owns the canvas, subscribes to drivers once into a
  shared `MirrorFeed`, pushes mirror geometry + SLR action set on start, and runs
  the `LayerManager` render loop.
- `src/shared/` — `types.ts`, `feed.ts`, `canvas.ts` (reference transform),
  `mirror.ts` (skeleton topology + drawing), `synth.ts` (Web Audio), `music.ts`,
  `particles.ts`, `media.ts`, `sign.ts`, `menu-controller.ts`, `assets.ts`,
  `deps.ts`.
- `src/layers/` — one file per experience.
- `assets/` — copied from the legacy app (menu icons, dance choreography + gif,
  music scores, sign-game backgrounds/characters/font/script, sign-training
  reference videos + `slr_samples`, the `aria` VRM model).

## Build

```bash
bun install
bun run build         # one-shot bundle into dist/main.js
bun run dev           # watch mode (a dev watcher is normally already running)
bun run typecheck     # tsc --noEmit
```

The app is registered in the repo root `build:apps` script.

## Configuration

All hardware adaptation is driven by a single persisted config object so the app
works on any screen, any webcam, and with or without a physical mirror — **no
rebuild required**. It lives in the app's key/value storage under `config` and is
deep-merged over the defaults on start (`src/shared/config.ts`).

The easiest way to edit it is the **Settings** button on the app's row in the
GOSAI dashboard, which renders a form from the declarative `settings` schema in
`gosai.app.json`. Changes apply on the next launch of the experience. You can
also set it directly via any GOSAI storage tool:

```
POST /v1/apps/second-self/storage/config
{
  "projection": { "mode": "direct", "mirror": true, "cameraFit": "contain", "zoom": 1.0 },
  "display":    { "fit": "contain" },
  "mirror":     { "x_offset": -230, "y_offset": 100, "screen_width_mm": 392.85,
                  "screen_height_mm": 698.4, "tilt_deg": 17 }
}
```

The three concerns are independent:

### `projection` — camera frame to reference space (any webcam)

| Field       | Values                  | Meaning                                                                        |
| ----------- | ----------------------- | ------------------------------------------------------------------------------ |
| `mode`      | `direct` / `reflection` | `direct` = webcam selfie overlay (default); `reflection` = physical mirror rig |
| `mirror`    | `true` / `false`        | Horizontal flip for a selfie view                                              |
| `cameraFit` | `contain` / `cover`     | `contain` shows the whole camera frame; `cover` fills + crops                  |
| `zoom`      | number (>=0.1)          | `>1` crops in for a fuller portrait fill                                       |

Webcam resolution/aspect is detected automatically (the `pose` driver reports
the frame size), so no per-camera setup is needed.

### `display` — reference space to physical screen (any size/orientation)

| Field             | Values                          | Meaning                                                                                   |
| ----------------- | ------------------------------- | ----------------------------------------------------------------------------------------- |
| `fit`             | `contain` / `cover` / `stretch` | `contain` letterboxes (no distortion, default); `cover` fills + crops; `stretch` distorts |
| `referenceWidth`  | number (default `1080`)         | Logical design space (experiences are portrait)                                           |
| `referenceHeight` | number (default `1920`)         | "                                                                                         |

Experiences are authored in the portrait reference space; `display.fit` adapts
them to any physical screen/orientation distortion-free (e.g. a portrait design
on a landscape monitor is letterboxed by default).

### `mirror` — physical augmented-mirror calibration (only `reflection` mode)

| Field                 | Default  | Meaning                      |
| --------------------- | -------- | ---------------------------- |
| `x_offset`            | `-230`   | Horizontal offset (mm)       |
| `y_offset`            | `100`    | Vertical offset (mm)         |
| `screen_width_mm`     | `392.85` | Physical mirror width        |
| `screen_height_mm`    | `698.4`  | Physical mirror height       |
| `tilt_deg`            | `17`     | Camera tilt above the mirror |
| `hfov_deg`            | `60`     | Camera horizontal FOV        |
| `scale`               | `1.0`    | Per-install distance scale   |
| `default_distance_mm` | `1500`   | Fallback subject distance    |

**Quick recipes**

- Laptop / any webcam (default): `projection.mode = "direct"`, `display.fit = "contain"`.
- Fill a portrait screen edge-to-edge: `projection.cameraFit = "cover"` (or raise `zoom`).
- Landscape monitor without bars: `display.fit = "cover"`.
- Physical augmented mirror: `projection.mode = "reflection"` + tune the `mirror` block.

## Assets & notes

- The `aria` layer loads `assets/aria/models/papa_de_him_chan.vrm`; if the model
  is missing it renders a labelled placeholder instead of failing.
- `sign-game` / `sign-training` require the SLR ONNX models bundled with the
  `slr` driver; the 16-sign action set is configured by `main.ts`.
- Large media (sign videos, dance gif, menu svg icons) were pulled via Git LFS
  from the legacy repo when copying assets.
