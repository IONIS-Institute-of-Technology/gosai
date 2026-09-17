# Second Self

Augmented-mirror experience pack for GOSAI v2. A webcam tracks the user; the
app projects interactive overlays onto a **portrait** mirror display (reference
space `1080x1920`) so that on-screen graphics line up with the user's
reflection.

This is a clean, type-safe port of the legacy `second-self` app pack. Where the
legacy version was many separate p5.js apps coordinated over Socket.IO, this is
a **single composited experience**: one fullscreen canvas, one driver feed, and
internal **layers** (one per legacy experience) run by the SDK's `LayerManager`
and toggled from a gesture menu. The app imports only the public `@gosai/sdk`
entry, like any third-party app.

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
| `calibrate`      | Guided mirror-calibration wizard; saving switches to reflection mode     |

The `LayerManager` enforces per-layer `exclusive` / `allowed` / `required`
relationships (ported from the legacy `processing.py` app-manager rules); the
menu is `persistent`. Per-layer menu options (the old `sub-menu.json` toggles)
live in `src/shared/layers.ts`.

## Drivers used

| Driver               | Why                                                                                          |
| -------------------- | -------------------------------------------------------------------------------------------- |
| `pose`               | MediaPipe Holistic landmarks (2D + metric 3D world); `raw_data` feeds aria, sleep, calibrate |
| `pose_to_mirror`     | Projects landmarks into mirror pixel space (`mirrored_data`)                                 |
| `frequency_analysis` | Microphone pitch/amplitude/FFT (`frequency`)                                                 |
| `slr`                | Sign-language recognition over a 30-frame window (`new_sign`)                                |

`pose_to_mirror` and `slr` are **new built-in drivers** added to `gosai/python`
for this app (the legacy platform had them; the new one did not). They are
webcam-only — there is no RealSense dependency. See
[`python/src/gosai_py/drivers/README.md`](../../python/src/gosai_py/drivers/README.md)
for driver notes, and the docstrings in `pose_to_mirror.py` / `slr.py`.

Audio synthesis (the legacy `synthesizer` driver) is done in the browser on the
runtime's `rt.audio` context in `src/shared/synth.ts`, with no Python round-trip.
The runtime resumes the context on start, so sound plays without a click.

The drivers only send the 478-point face mesh while a layer needs it: the raw
`pose` stream while `aria` runs, the mirrored stream while `face` runs.

## Architecture

```
webcam ─▶ pose ─┬─▶ pose_to_mirror ─(mirrored_data)─┐
                ├─▶ slr ─────────────(new_sign)──────┤
                └────────────────────(raw_data)──────┤  (aria, sleep, calibrate)
mic ────────────▶ frequency_analysis (frequency)─────┤
                                                      ▼
                                            main.ts compositor + feed
                                                      │
                                               SDK LayerManager
                                                      │
                                   layers ──▶ 1080x1920 portrait canvas
                                   theremine/music ──▶ shared/synth.ts (rt.audio)
                                   aria ──▶ offscreen WebGL, drawn in z-order
```

- `src/main.ts`: the compositor. It owns the SDK fullscreen canvas, subscribes
  to the drivers once into a shared `MirrorFeed`, applies the mirror projection
  and the SLR action set on start, runs the layers and suspends them while the
  display sleeps.
- `src/shared/`: `types.ts` (driver payload types come from the SDK),
  `feed.ts`, `layers.ts` (layer definitions and menu options), `deps.ts`,
  `config.ts` (settings), `projection.ts` (mirror projection and calibration
  profile), `draw.ts`, `ui.ts` (cursor, dwell buttons, progress rings),
  `mirror.ts` (skeleton topology and drawing), `align.ts`, `synth.ts`,
  `music.ts`, `particles.ts`, `media.ts` (per-layer images and videos),
  `sign.ts`, `sleep.ts`.
- `src/layers/`: one file per experience.
- `test/`: unit tests for the pure parts.
- `assets/` — copied from the legacy app (dance choreography + animated webp,
  music scores, sign-game backgrounds/characters/font/script, Aria's sign videos
  in `signs/` shared by sign-game and sign-training, sign-training's own
  reference videos + `slr_samples`, the `aria` VRM model).

## Build

```bash
bun install
bun run build         # one-shot bundle into dist/main.js
bun run dev           # watch mode (a dev watcher is normally already running)
bun run typecheck     # tsc --noEmit
bun run test          # bun test
```

The app is registered in the repo root `build:apps` script.

## Configuration

Configuration is intentionally minimal: two projection fields and the sleep
settings. Everything else is automatic or produced by the in-app calibration
wizard:

| Field                   | Values                  | Meaning                                                                        |
| ----------------------- | ----------------------- | ------------------------------------------------------------------------------ |
| `projection.mode`       | `direct` / `reflection` | `direct` = webcam selfie overlay (default); `reflection` = physical mirror rig |
| `projection.mirror`     | `true` / `false`        | Horizontal flip for a selfie view (direct mode)                                |
| `sleep.enabled`         | `true` / `false`        | Presence-based display sleep (default `true`)                                  |
| `sleep.wakeConfidence`  | `0..1`                  | Smoothed pose confidence needed to wake (default `0.6`)                        |
| `sleep.sleepConfidence` | `0..1`                  | Below this the user counts as absent (default `0.35`)                          |
| `sleep.sleepDelaySec`   | seconds                 | Continuous absence before falling asleep (default `7`)                         |
| `sleep.maxDistanceM`    | meters                  | People estimated farther than this are ignored (default `2`)                   |

When nobody is detected in front of the mirror for `sleepDelaySec`, the display
falls completely dark with a "magic veil" animation: a soft opacity gradient
closes over the screen from the center, trailing sparkles. While dark, layer
layers are suspended: they stop drawing, and sound and videos stop. Someone standing in front for 2 seconds straight
(passers-by are ignored) wakes it with the reverse reveal plus expanding water
ripples. Presence is derived from the visibility of the core body landmarks
(nose/shoulders/hips) in the raw `pose` feed, gated by the person's estimated
distance (weak-perspective shoulder-span estimate, same math as
`pose_to_mirror`), smoothed and hysteresis-gated so the mirror never flickers
between states.

The fields are declared in `gosai.app.json`, which also holds their defaults
and bounds. The app reads them through `rt.settings`. Edit them with the app's
**Settings** button in the dashboard, or send the server's `app:settings:set`
command with `{ "appSlug": "second-self", "values": { "projection.mode":
"reflection" } }`.

Everything else adapts by itself:

- **Webcam resolution/aspect** is detected automatically (the `pose` driver
  reports the frame size).
- **Screen size/orientation**: experiences are authored in a fixed portrait
  `1080x1920` reference space that is aspect-preserving (`contain`) fit onto the
  window — any 9:16 display (1080x1920, WQHD 1440x2560, 4K portrait) fills
  edge-to-edge, other aspects letterbox without distortion.
- **Mirror projection** (reflection mode) is _fitted_, not typed in — see below.

## Setting up a physical mirror rig

1. **Camera**: in the dashboard's per-app device panel assign the camera and,
   if it is mounted in portrait, set its rotation (`90`/`270`) so the frame is
   upright. Mount it as close to the display as practical, roughly centered,
   tilted slightly down is fine — the tilt is calibrated away.
2. **Calibrate on the mirror**: open the gesture menu and select **Calibrate**
   (always available — no dashboard needed, so it works in kiosk mode). You
   point your index finger so its _reflection_ covers each target dot and hold
   still (~8 dots, one round near + one round a step back, ~90 seconds total).
   The `pose_to_mirror` driver fits the camera tilt, the distance scale and
   the mm→pixel affine from the samples (`solve_calibration`), shows the
   residual error, and overlays the now-calibrated skeleton on your reflection
   for a dwell-to-confirm **Save / Redo**.
3. **Saving switches the app to reflection mode** automatically and persists
   both the mode and the fitted profile (`mirror_calibration` in app storage);
   the profile is pushed to the driver on every start. Leaving the wizard
   without saving puts the saved projection back. An app already in
   reflection mode with no profile walks straight into the wizard on launch.
   Re-run the wizard whenever the camera or display moves.

No millimetres, offsets, FOVs or tilt angles are ever entered by hand.

## Assets & notes

- The `aria` layer loads `assets/aria/models/papa_de_him_chan.vrm`; if the model
  is missing it renders a labelled placeholder instead of failing.
- `sign-game` / `sign-training` require the SLR ONNX models bundled with the
  `slr` driver; the 16-sign action set is configured by `main.ts`.
- Large media (sign videos, sprites, backgrounds, the dance animation and the
  VRM model) is stored with Git LFS.
