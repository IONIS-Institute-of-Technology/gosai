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
| `pose`               | MediaPipe Holistic landmarks (2D + metric 3D world landmarks) |
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
                └─▶ slr ─────────────(new_sign)──────┤
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

## Mirror calibration

`pose_to_mirror` needs the physical mirror geometry to align the reflection.
Defaults come from the legacy `config.json` and are pushed by `main.ts` on start
(`set_mirror_config`):

| Field              | Default         | Meaning                      |
| ------------------ | --------------- | ---------------------------- |
| `x_offset`         | `-230`          | Horizontal offset (mm)       |
| `y_offset`         | `100`           | Vertical offset (mm)         |
| `screen_width_mm`  | `392.85`        | Physical mirror width        |
| `screen_height_mm` | `698.4`         | Physical mirror height       |
| `width`/`height`   | `1080` / `1920` | Display resolution (px)      |
| `tilt_deg`         | `17`            | Camera tilt above the mirror |

Tune these per physical install (edit `MIRROR_CONFIG` in `src/main.ts` or push a
new `set_mirror_config` action at runtime).

## Assets & notes

- The `aria` layer loads `assets/aria/models/papa_de_him_chan.vrm`; if the model
  is missing it renders a labelled placeholder instead of failing.
- `sign-game` / `sign-training` require the SLR ONNX models bundled with the
  `slr` driver; the 16-sign action set is configured by `main.ts`.
- Large media (sign videos, dance gif, menu svg icons) were pulled via Git LFS
  from the legacy repo when copying assets.
