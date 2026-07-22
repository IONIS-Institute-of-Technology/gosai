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
| `calibrate`      | Guided mirror-calibration wizard (reflection mode only)                  |

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

Configuration is intentionally minimal — two fields, everything else automatic
or produced by the in-app calibration wizard:

| Field                   | Values                  | Meaning                                                                        |
| ----------------------- | ----------------------- | ------------------------------------------------------------------------------ |
| `projection.mode`       | `direct` / `reflection` | `direct` = webcam selfie overlay (default); `reflection` = physical mirror rig |
| `projection.mirror`     | `true` / `false`        | Horizontal flip for a selfie view (direct mode)                                |
| `sleep.enabled`         | `true` / `false`        | Presence-based display sleep (default `true`)                                  |
| `sleep.wakeConfidence`  | `0..1`                  | Smoothed pose confidence needed to wake (default `0.6`)                        |
| `sleep.sleepConfidence` | `0..1`                  | Below this the user counts as absent (default `0.35`)                         |
| `sleep.sleepDelaySec`   | seconds                 | Continuous absence before falling asleep (default `12`)                       |

When nobody is detected in front of the mirror for `sleepDelaySec`, the display
falls completely dark with a "magic veil" animation (a glowing iris ring closes
over the screen, trailing sparkles); while dark, layer rendering is skipped
entirely. When someone approaches, the veil reopens from the person's head
position with the reverse reveal. Presence is derived from the visibility of
the core body landmarks (nose/shoulders/hips) in the raw `pose` feed, smoothed
and gated with hysteresis so the mirror never flickers between states.

It lives in the app's key/value storage under `config` (edit via the app's
**Settings** button in the dashboard, or `POST
/v1/apps/second-self/storage/config` with
`{ "projection": { "mode": "reflection" } }`).

Everything else adapts by itself:

- **Webcam resolution/aspect** is detected automatically (the `pose` driver
  reports the frame size).
- **Screen size/orientation**: experiences are authored in a fixed portrait
  `1080x1920` reference space that is aspect-preserving (`contain`) fit onto the
  window — any 9:16 display (1080x1920, WQHD 1440x2560, 4K portrait) fills
  edge-to-edge, other aspects letterbox without distortion.
- **Mirror projection** (reflection mode) is *fitted*, not typed in — see below.

## Setting up a physical mirror rig

1. **Camera**: in the dashboard's per-app device panel assign the camera and,
   if it is mounted in portrait, set its rotation (`90`/`270`) so the frame is
   upright. Mount it as close to the display as practical, roughly centered,
   tilted slightly down is fine — the tilt is calibrated away.
2. **Mode**: set `projection.mode = "reflection"` in the app settings.
3. **Calibrate on the mirror**: on the next launch, if no calibration profile
   exists the app walks straight into the wizard (it is also always available
   from the gesture menu as **Calibrate**). You point your index finger so its
   *reflection* covers each target dot and hold still (~8 dots, one round near
   + one round a step back, ~90 seconds total). The `pose_to_mirror` driver
   fits the camera tilt, the distance scale and the mm→pixel affine from the
   samples (`solve_calibration`), shows the residual error, and overlays the
   now-calibrated skeleton on your reflection for a dwell-to-confirm
   **Save / Redo**.
4. The fitted profile persists in app storage under `mirror_calibration` and is
   pushed to the driver on every start. Re-run the wizard whenever the camera
   or display moves.

No millimetres, offsets, FOVs or tilt angles are ever entered by hand.

## Assets & notes

- The `aria` layer loads `assets/aria/models/papa_de_him_chan.vrm`; if the model
  is missing it renders a labelled placeholder instead of failing.
- `sign-game` / `sign-training` require the SLR ONNX models bundled with the
  `slr` driver; the 16-sign action set is configured by `main.ts`.
- Large media (sign videos, dance gif, menu svg icons) were pulled via Git LFS
  from the legacy repo when copying assets.
