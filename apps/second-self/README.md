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

The `LayerManager` enforces per-layer `exclusive` / `allowed` / `required`
relationships (ported from the legacy `processing.py` app-manager rules); the
menu is `persistent`. Per-layer menu options (the old `sub-menu.json` toggles)
live in `src/shared/layers.ts`.

Every layer introduces itself. Nothing here has a label on it (the only input
is your body in front of a camera), so a layer that explains nothing is a layer
nobody can play. Each one declares a `guide` in `main.ts`: a card with its name
and one or two lines about what to do, shown in the middle of the mirror for
seven seconds when the layer starts, then a single hint line along the bottom
edge for as long as it runs. Starting Dance introduces the dance, not the Body
overlay it pulls in with it. While nothing but the overlays run, the hint is
the one for the menu itself. `src/shared/guide.ts` holds the overlay; the menu
layer draws it, being persistent and above everything else.

The mirror calibration is a second experience, `calibrate`, rather than a
layer: see [Setting up a physical mirror rig](#setting-up-a-physical-mirror-rig).
The menu's last row, **Calibrate**, switches to it.

## Drivers used

| Driver               | Why                                                                                          |
| -------------------- | -------------------------------------------------------------------------------------------- |
| `pose`               | MediaPipe Holistic landmarks (2D + metric 3D world); `raw_data` feeds aria, sleep, calibrate |
| `pose_to_mirror`     | Projects landmarks into mirror pixel space (`mirrored_data`)                                 |
| `frequency_analysis` | Microphone pitch/amplitude/FFT (`frequency`)                                                 |
| `slr`                | Sign-language recognition over a 30-frame window (`new_sign`)                                |

The `slr` driver runs its 30-frame window on every camera frame, so it guesses
about 30 times a second, and those guesses are noisy in both directions: they
drop out in the middle of a sign being performed correctly, and they land
confidently on a sign nobody is making when the hand landmarks are poor. No
layer acts on a guess. `SignTracker` keeps **evidence** per sign, in
milliseconds: time recognised as a sign adds to that sign's budget, time
recognised as something else drains the others but slowly, and a sign is acted
on at `SIGN_EVIDENCE_MS`. A sign seen most of the time therefore still adds up,
while one seen a quarter of the time never does. Two gates sit in front of it:
nothing counts while no hand is tracked (without hands the recogniser is
classifying zero-padded input, and it is confident about it), and nothing
counts until the tracker is **armed**, which takes a moment of hands at rest.
Arming is what stops hands that happen to be up when a question appears from
answering it: a recogniser stuck on one sign then fails safe, doing nothing,
rather than picking for you. The layers draw the evidence as a bar on the clip
being copied, and say "hands down" while they are waiting to arm.

Two more rules come from the vocabulary itself. A layer declares which signs it
will act on (`setCandidates`), so a guess outside that set is noise: it barely
drains the sign being attempted and can never be committed. That matters
because the recogniser wanders, and "television" landing in the middle of
someone signing "left" used to cost them their progress. And the leader must be
clearly ahead of the runner-up before it counts: several signs look alike to
the model, "left" and "right" worst of all, and committing whichever crossed
the line first would be a coin toss in a game about learning which is which.
Lookalikes therefore commit to nothing, and `sign-game` uses `contested()` to
say "too alike" rather than leave the screen silently refusing to move.

Choices are answered by signing and nothing else. A fingertip dwell on the
columns, the launcher's interaction, was tried as a way out of an unanswerable
choice and removed: a hand performing signs passes over the columns constantly,
so it fired by accident while someone was signing. Anything added here has to
survive a hand that is already moving all over the screen.

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
                └────────────────────(raw_data)──────┤  (aria, sleep)
mic ────────────▶ frequency_analysis (frequency)─────┤
                                                      ▼
                                            main.ts compositor + feed
                                                      │
                                               SDK LayerManager
                                                      │
                                   layers ──▶ 1080x1920 portrait canvas
                                   theremine/music ──▶ shared/synth.ts (rt.audio)
                                   aria ──▶ WebGL canvas stacked below
```

- `src/main.ts`: the compositor. It owns the SDK fullscreen canvas, subscribes
  to the drivers once into a shared `MirrorFeed`, applies the mirror projection
  and the SLR action set on start, runs the layers and suspends them while the
  display sleeps.
- `src/calibrate.ts`: the calibration experience. `src/calibration/` holds the
  mirror wizard and the control window GOSAI opens next to it.
- `src/shared/`: `types.ts` (driver payload types come from the SDK),
  `feed.ts`, `layers.ts` (layer definitions, menu options and guides),
  `guide.ts` (the intro card and hint line), `assets.ts` (asset health),
  `deps.ts`,
  `config.ts` (settings), `projection.ts` (mirror projection),
  `calibration.ts` (the calibration profile, and entering and leaving the
  calibration), `draw.ts`, `ui.ts` (cursor, dwell buttons, progress rings),
  `mirror.ts` (skeleton topology and drawing), `align.ts`, `synth.ts`,
  `music.ts`, `particles.ts`, `media.ts` (per-layer images and videos),
  `sign.ts`, `sleep.ts`.
- `src/layers/`: one file per layer.
- `test/`: unit tests for the pure parts.
- `assets/` — copied from the legacy app (dance choreography + animated webp,
  music scores, sign-game backgrounds/characters/font/script, Aria's sign videos
  in `signs/` shared by sign-game and sign-training, sign-training's
  `slr_samples`, the `aria` VRM model).

## Build

```bash
bun install
bun run build         # one-shot bundle into dist/main.js and dist/calibrate.js
bun run dev           # watch mode (a dev watcher is normally already running)
bun run typecheck     # tsc --noEmit
bun run test          # bun test
```

The app is registered in the repo root `build:apps` script.

## Configuration

Configuration is intentionally minimal: two projection fields and the sleep
settings. Everything else is automatic or produced by the mirror calibration:

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
  reports the frame size). Direct mode center-crops the frame to the portrait
  reference space (`fit: cover`) instead of letterboxing it into it, so a hand
  can reach every position on the display. A landscape webcam keeps its full
  height and roughly its central third (31% of the width at 16:9, 42% at 4:3);
  a portrait-rotated camera is used whole. Stand centered: outstretched arms
  leave the crop, and the `body` overlay's corner arrows point the way back.
- **Screen size/orientation**: experiences are authored in a fixed portrait
  `1080x1920` reference space that is aspect-preserving (`contain`) fit onto the
  window. Any 9:16 display (1080x1920, WQHD 1440x2560, 4K portrait) fills
  edge-to-edge; other aspects letterbox without distortion. On a landscape
  screen, a laptop running `bun run dev` for instance, the app is a portrait
  strip centered between black bars, laid out and proportioned exactly as it is
  on the mirror, and all of it stays reachable.
- **Mirror projection** (reflection mode) is _fitted_, not typed in — see below.

## Setting up a physical mirror rig

1. **Camera**: in the dashboard's per-app device panel assign the camera and,
   if it is mounted in portrait, set its rotation (`90`/`270`) so the frame is
   upright. Mount it as close to the display as practical, roughly centered,
   tilted slightly down is fine — the tilt is calibrated away.
2. **Calibrate on the mirror**: open the gesture menu and select **Calibrate**
   (always available, no dashboard needed, so it works in kiosk mode), or use
   the app's **Calibrate** button in the dashboard, or launch a kiosk with
   `--kiosk-calibrate`. You point your index finger so its _reflection_ covers
   each target dot and hold still (~8 dots, one round near + one round a step
   back, ~90 seconds total). The `pose_to_mirror` driver fits the camera tilt,
   the distance scale and the mm→pixel affine from the samples
   (`solve_calibration`), shows the residual error, and overlays the
   now-calibrated skeleton on your reflection for a dwell-to-confirm
   **Save / Redo**. Dwelling on **Back** at the top leaves without saving.
3. **Saving switches the app to reflection mode** automatically and persists
   both the mode and the fitted profile, as the app's `mirror-reflection`
   calibration profile; the profile is pushed to the driver on every start.
   Leaving without saving puts the saved projection back. From the menu, the
   calibration returns to the main experience either way; from the dashboard or
   a kiosk, GOSAI closes its windows. An app already in reflection mode with no
   profile walks straight into the calibration on launch, except right after
   someone left it. Re-run the calibration whenever the camera or display
   moves.

The calibration is the `calibrate` experience, declared as the manifest's
`calibration.experience`. Installs calibrated before it kept the profile under
`mirror_calibration` in app storage; the first start converts it into the
calibration profile.

No millimetres, offsets, FOVs or tilt angles are ever entered by hand.

## Assets & notes

- The `aria` layer loads `assets/aria/models/papa_de_him_chan.vrm`; if the model
  is missing it renders a labelled placeholder instead of failing.
- `sign-game` / `sign-training` require the SLR ONNX models bundled with the
  `slr` driver; the 16-sign action set is configured by `main.ts`.
- `sign-training`'s correction references in `assets/sign-training/slr_samples/`
  are 30 recorded frames per sign, and how much they move varies a lot: some
  are real animations (`goodbye`'s hand travels 3374 px), while others are
  effectively a held pose (`ok` travels 16 px, `television` 24 px). The step is
  therefore presented as a pose to move onto rather than a motion to follow,
  with per-joint marks and per-part bars showing what is still off. The
  tolerances are a fraction of each reference's own nose-to-hip distance
  (`BODY_TOLERANCE`, `HAND_TOLERANCE`), because the samples were recorded at
  different distances from the camera and a fixed pixel tolerance made some
  signs stricter than others. A reference frame with no hand is stored as all
  zeros; that hand is skipped rather than counted as a miss.
- Large media (sign videos, sprites, backgrounds, the dance animation and the
  VRM model) is stored with Git LFS. **Run `git lfs install && git lfs pull`
  in the GOSAI repository before running the app.** Without it every one of
  those files is a 130-byte pointer stub that fetches with a 200 and decodes
  into nothing: Aria has no model, Dance has no dancer, and the sign modules
  have no clips to copy. The `slr` driver's ONNX models are LFS objects too,
  so sign recognition does not run at all.
- Layers declare the files they cannot work without through
  `deps.assets.require(...)` in `preload`. Anything missing, or still a Git LFS
  pointer, is logged and shown on the mirror on the layer's card, with the
  command that fixes it, instead of the layer drawing an empty screen.
- `sign-game`'s character sprites in `assets/sign-game/characters/*/sprites/`
  are cropped to one box shared by every character, so a single draw box lands
  them all on the same ground line at the same scale and nobody shifts when the
  sprite changes. They were exported as 1920x1080 frames with the character
  filling a small part of the canvas, which drew every character at about a
  quarter of their intended size. A new sprite exported the same way joins them
  with:

  ```python
  # Run from python/ with `./.venv/bin/python`. The crop box is the union of
  # every sprite's alpha bounding box; re-run over all of them when adding art
  # that falls outside it, or the characters stop lining up.
  from PIL import Image
  import glob
  files = sorted(glob.glob('../apps/second-self/assets/sign-game/characters/*/sprites/*.png'))
  boxes = [Image.open(f).convert('RGBA').getbbox() for f in files]
  crop = (min(b[0] for b in boxes), min(b[1] for b in boxes),
          max(b[2] for b in boxes), max(b[3] for b in boxes))
  for f in files:
      Image.open(f).convert('RGBA').crop(crop).save(f, optimize=True)
  ```

- The `sign-game` backgrounds are wide (up to 3:1) and the mirror is portrait,
  so they are drawn cropped to fill (`drawCover`) rather than squeezed into the
  frame, which distorted every one of them.
- Aria's sign clips in `assets/signs/Aria/` are cropped to the area she uses
  across all of them, at 444x648 with alpha and no audio, so she fills the
  boxes that sign-game and sign-training draw them in. A new clip recorded at
  1920x1080 with the same framing matches the others with:

  ```bash
  opts=(-an -vf crop=592:864:420:200,scale=444:648:flags=lanczos -c:v libvpx-vp9
        -pix_fmt yuva420p -b:v 0 -crf 36 -row-mt 1 -deadline good -cpu-used 1)
  # Decode with libvpx-vp9: ffmpeg's own VP9 decoder drops the alpha channel.
  ffmpeg -c:v libvpx-vp9 -i sign.webm "${opts[@]}" -pass 1 -f webm /dev/null
  ffmpeg -c:v libvpx-vp9 -i sign.webm "${opts[@]}" -pass 2 assets/signs/Aria/sign.webm
  ```
