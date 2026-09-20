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
It is run from the dashboard's **Calibrate** button, and the menu does not
offer it: the menu is what the public touches, and the calibration needs a
keyboard the mirror does not have.

## Drivers used

| Driver               | Why                                                                                          |
| -------------------- | -------------------------------------------------------------------------------------------- |
| `pose`               | MediaPipe Holistic landmarks (2D + metric 3D world); `raw_data` feeds aria, sleep, calibrate |
| `pose_to_mirror`     | Projects landmarks into mirror pixel space (`mirrored_data`)                                 |
| `frequency_analysis` | Microphone pitch/amplitude/FFT (`frequency`)                                                 |
| `slr`                | Sign-language recognition over a 30-frame window (`new_sign`)                                |
| `camera`             | Calibration only: the frames the printed board is found in                                   |
| `mirror_calibration` | Calibration only: board detection, lens intrinsics and the rig fit                           |

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
  `config.ts` (settings, the mirror profile and the stored lens),
  `projection.ts` (mirror projection), `calibration.ts` (the calibration
  profile and the lens profile, and leaving the calibration),
  `draw.ts`, `ui.ts` (cursor, dwell buttons, progress rings),
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

Configuration is intentionally minimal: the projection fields and the sleep
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

There is no setting about the person in front of the mirror, on purpose. The
mirror stands in a busy public space where nobody measures their pupils, so the
driver sizes up each visitor itself and draws for the midpoint of their eyes.
Reflection mode without a saved calibration profile falls back to direct mode
and logs one warning saying to run Calibrate from the dashboard: a mirror with
no rig would otherwise draw nothing at all.

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
- **Mirror projection** (reflection mode) is fitted on the rig itself, from a
  printed board and a handful of measurements: see below.

## Setting up a physical mirror rig

The rig is a display behind a half-silvered mirror with a webcam on it. The
calibration works out where that display sits in the camera's own coordinates,
so the app can draw a body point where its reflection appears to the viewer.
Plan on about fifteen minutes for a first run.

**Accuracy has not been measured on a physical rig yet.** The numbers the
wizard shows come from the fit and from targets held out of it; nothing here
has been checked against a tape measure on a real mirror. Treat the millimetre
figures as the wizard's own opinion of itself until that trial happens.

### The two windows

The mirror has no keyboard and no mouse. Start the calibration from the app's
**Calibrate** button in the GOSAI dashboard: GOSAI opens two windows for it.

- The **mirror window** runs the flow and shows the targets, the camera
  preview, the instructions, the results and, at the end, the skeleton on your
  reflection. It takes no input at all.
- The **control window** lands on another display, the one with the keyboard
  and the mouse, and holds every field, every button and every shortcut. It
  draws whatever the mirror says it is doing and sends commands back.

Either window may open or be reloaded first; the control window asks the mirror
where the run is as soon as it appears. Started without a control window, the
mirror says so and goes back to the main experience after ten seconds, because
there would be no way to answer it.

The shortcuts, all in the control window: **Space**, **Enter** or **Page Down**
for the main action of the screen (capture, during the alignment), **T** for a
capture after a countdown, **Backspace** to drop the last capture, the **arrow
keys** to trim at the end, **Escape** to leave. They do nothing while you are
typing in a field.

### 1. Print the board

Print `assets/calibration/charuco-a4.pdf` or `charuco-letter.pdf` **at 100%
(actual size)**, with any "fit to page" or "shrink oversized pages" option
turned off. Measure the ruler printed in the left margin: it has to be exactly
100 mm. If it is not, the whole calibration is scaled wrong, and nothing later
in the flow can notice.

Glue or tape the sheet to something flat and rigid (foam board, a clipboard, a
sheet of MDF). A sheet that bows makes the detected board pose wander. The
marked corner at the top left, ringed and labelled **ORIGIN**, is the point
every alignment is about.

### 2. Camera

In the dashboard's per-app device panel assign the camera and, if it is mounted
in portrait, set its rotation (`90`/`270`) so the frame is upright. Fix it so it
cannot shift, and redo the calibration if it ever does.

Where it goes matters more than it looks. A visitor's depth is estimated, and
an error in it moves the drawing sideways by that error times the distance on
the glass from the point nearest the camera: a depth off by 10% moves a hand
resting by the hip by about 6 cm. So mount the camera as close to the middle of
the drawn area as the rig allows, and low enough to see a visitor's feet if you
can, which earns the floor cue below.

Its resolution buys range. The main size cue reads the visitor's iris, which
needs roughly 5 pixels across, so a 720p camera of this field of view loses it
somewhere near 2.5 m and a 1080p one keeps it half as far again. Capture at
1080p if the machine holds its frame rate there.

### 3. Measure

The control window opens on a form. It wants, all in millimetres:

- **Active screen width and height**: the lit area behind the mirror, not the
  frame around it. The mirror window must fill that display, which it does in
  kiosk and fullscreen; the wizard works out how much of the screen the
  portrait `1080x1920` canvas actually covers from the window layout.
- **Mirror to pixel plane**: from the mirror surface to the pixels, through the
  glass. A ruler at the edge of the panel is enough. Default 5 mm; under 10 mm
  this is a secondary effect, worth a scalar and not worth agonising over.
- **Camera lens above the floor**: optional, and worth the two minutes. It lets
  the mirror size up each visitor, children included, from their feet standing
  on the floor. It assumes the mirror hangs plumb. Leave it empty to turn that
  cue off.
- **Your pupil distance**: hold a ruler against the mirror, close one eye at a
  time and read the distance between your pupils. 58 to 68 mm for most adults.
  It sets the scale of the head your eye position is read from, so it is the
  one number about you the fit depends on. It is used for this run and is not
  stored: the mirror keeps no settings about anybody.
- **Which eye stays open**: right by default. Keep the other one closed for the
  whole alignment.

A previous run's screen size, gap and camera height come back prefilled.

### 4. Lens

The camera's intrinsics are calibrated once from the same sheet. Wave it slowly
through the camera's view: near and far, in the corners and along the edges,
tilted away from the camera in different directions. The mirror shows the live
picture (mirrored, so moving it left moves the picture left), outlines the
board when it is found, flashes when a view is kept, and tells you what is
still missing. At 100% it solves, then shows the reprojection error and the
field of view it found.

The lens is saved on its own, under `lens_profile` in app storage, because it
describes the camera rather than the mirror. The next run offers **reuse** (with
its error and date) as the default and **recalibrate** as the alternative. Redo
it when the camera is swapped, its resolution or zoom changes, or anything in
the optical path in front of it changes. A mirror recalibration on the same
camera does not need it.

### 5. Align

This is the part that fits the rig. Close the eye you chose and keep it closed:
a flat display can only register with one eye at a time, and switching eyes
mid-run poisons the fit.

A mark appears on the mirror. Hold the sheet up so the **reflection** of its
ORIGIN corner sits on the mark, with your face and the whole sheet still in the
camera's view, then confirm from the control window. Nothing is ever confirmed
by holding still. Holding still is not evidence that the reflection is on the
mark.

Working alone, with the keyboard on the other display, press **T** instead: the
mirror counts down from five and takes the capture when it reaches zero. It is
still you who asked for it, at a moment you chose; the driver averages the few
hundred milliseconds that end at the capture, so the sheet only has to be still
at the end of the count. Any other command calls the countdown off.

The screen says how to hold the sheet for each target, upright or turned half a
turn, because a mark low on the display needs the board well below your eye and
a camera on top of the display soon loses sight of it. It also shows whether
the sheet and your face are being tracked, how far the sheet is, and asks you
to tilt the sheet when its pose is too ambiguous to use. **Backspace** drops the
last capture and asks for it again. **Escape** leaves without saving.

Four targets are taken close to the mirror (about 0.9 m), then four more from
further back (about 1.5 m). Both distances are required: one distance fits its
own targets just as well and leaves the mirror pose barely constrained. The
wizard asks the driver which targets you can actually reach from where you
stand and spreads its four over different rows and columns. While it can plan
none it says why, in the driver's words rather than a guess: face the camera so
your face is tracked, or step back because there is no room to hold the board
in front of you. Otherwise it says how many of the marks are reachable and
waits while you step back or raise the sheet.

### 6. Read the result

The fit reports an **expected alignment error** in millimetres (good under
15 mm, fair under 30 mm, poor above), its own rms residual, the camera tilt,
where it thinks the camera is relative to the canvas centre, and the standing
distances it used. Check the camera position against where the camera actually
is: a fit that puts it half a metre off is wrong whatever its residuals say.

It also reports what your own irises read: **iris reads 12.6 mm (assumed
12.3 mm)**. Your pupil distance is measured, so during the alignment your eyes
were at a known depth, and what the landmarks made of your irises at that depth
is what this camera reads an iris as. The assumed number is that reading pulled
back toward the 11.7 mm nearly everybody has, because one person's irises
cannot say how much of the difference is the camera and how much is them. The
mirror sizes strangers with the assumed number, so it travels inside the rig.
The wizard also splits the readings into the near and far halves of where you
stood, and says so when they differ by more than 8%: that would mean the
landmark model's reading follows how big the iris is in the picture, and then
no single number is right at both distances.

A **poor** fit, or none at all, usually means the two standing distances were
too close together, the targets sat in the same rows or columns, the wrong eye
was closed (or it changed), or a measurement was typed in wrong. The control
window then offers four more targets at a third distance, taking the worst
target again, or starting the alignment over.

### 7. Check, trim and save

Three more targets follow at an in-between distance, kept out of the fit. Their
error is the honest number: it says how far off the drawing is at places the
fit never saw. It is shown larger than the rms for that reason.

Then the skeleton is drawn on your reflection with the fitted projection
applied live, using the pupil distance you typed rather than the one the mirror
assumes for strangers, so what you are judging is the rig. Open **both** eyes
now and move closer, further and side to side; the drawing is for the midpoint
of your eyes, so expect a small split that no calibration can remove on a flat
display. The control window shows what the driver makes of you while you move:
your estimated size and each of the three size cues on its own ("pupils",
"iris", "feet"), so you can see which ones are alive where you are standing. The
**arrow keys** nudge the drawing by 1 px (5 px with shift), up to 60 px, the
same limit a stored trim is clamped to when it is read back. That trim is a
perceptual nudge, stored beside the rig rather than inside it; above 25 px the
screen warns that a trim that large is covering for a poor fit rather than
correcting a perception. **Enter** saves, and saving puts the assumed pupil
distance back where it was.

Saving switches the app to reflection mode and persists both the mode and the
profile as the app's `mirror-reflection` calibration profile, which is pushed
to the driver on every start. Leaving without saving puts the saved projection
back and drops the captures. Either way GOSAI closes both windows.

### What a visitor gets

Nobody in front of a public mirror types anything, so the driver works the rest
out per visitor, every frame:

- **Their size**, from three cues:
  - the spacing their pupils appear to have, against an assumed 63 mm. That is
    a prior about people rather than a measurement of this one, and it is 20%
    wrong about a small child. It is the least trusted cue and the only one
    that is always there.
  - the apparent size of their irises, against the diameter the calibration
    measured for this camera. An iris is about 11.7 mm across in nearly
    everybody from the age of two, so this cue does not care who is standing
    there. It is the main one, and it is alive whenever the face is close
    enough to read.
  - their feet on the floor, against the camera height you measured. It owes
    nothing to the person's size either, but a camera mounted on a mirror
    seldom has feet in view, so treat it as an occasional bonus.

  The three are fused over a sliding window, each weighted by how far it can be
  off for a stranger, and the estimate restarts when the next person walks up.
  On a synthetic child of 0.65 scale with 52 mm pupils standing 2 m back, feet
  out of the frame, the pupil prior alone reads 21% too large and the fused
  answer 1%, which takes the drawing error from 592 px to 32 px on the
  `1080x1920` canvas.

- **Their viewpoint**, always the midpoint of their eyes. A flat display cannot
  register with both eyes at once and nobody walking up to a mirror picks one,
  so the midpoint is everybody's compromise.

The limits follow from the same arithmetic:

- The iris has to be about 5 pixels across to be read at all, so the cue dies
  at roughly 2.5 m on a 720p camera of this field of view, later at 1080p. Past
  that the pupil prior is on its own again unless the feet are in view.
- Glasses and half closed eyes move the iris landmarks, and a head turned
  sideways and tilted at the same time makes both measured diameters shorter,
  which reads a few percent too far. None of this has been measured on the rig
  yet: the numbers above are synthetic.
- The pupil prior is a population average, so where neither other cue is
  available a visitor whose eyes sit unusually close or wide is drawn at the
  wrong depth. That is why the camera height is worth measuring and why a
  camera low enough to see feet beats one that is not.
- Because the error grows with distance from the point nearest the camera, a
  camera near the middle of the drawn area beats one perched above it.

Millimetres are typed by hand in one place only, the form above, and only those
five numbers. Offsets, fields of view and tilt angles are never entered.

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
