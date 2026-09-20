# Driver notes

Built-in GOSAI drivers live here. Each is a `BaseDriver` subclass
auto-discovered by the Python bridge (see
`tests/test_drivers_discovery.py`). This note covers the drivers added for the
**second-self** app and the `ball` driver's runtime backends; the rest are
documented by their module docstrings.

## Behaviour changes for driver callers

Actions now decode their `data` with msgspec against the types in each
driver's schema (`uv run python -m gosai_py.schemas`), so some inputs that used
to be coerced or ignored behave differently:

- Integer fields reject fractional numbers (`3.5`); whole floats (`3.0`) and
  numeric strings (`"7"`) still convert. `null` in a field that isn't nullable
  raises instead of falling back to a default.
- Booleans convert from strings, so `set_flip("false")` now means false.
  Before, any non-empty string meant true.
- `ball.set_output_size` needs both `width` and `height`.
- `pose_to_mirror.set_mirror_config` rejects the whole update when one field is
  invalid (unknown `mode` or `fit`, a `trim_px` without 2 numbers, a
  non-numeric setting). Before, bad values were logged and skipped.
- `calibration.compute` raises on a `focus_quad` that isn't 4 points or a
  non-positive `frame_size`, instead of ignoring them.
- `interpolate.reset` takes a stream name or `null`. `reset({"name": ...})`
  now raises; before, it reset every stream.
- Actions that take no data, such as `calibration.clear`, ignore whatever
  `data` they receive.

The `ball` event sends `diameter` instead of `r`.

## `pose` hand-key convention (important)

`pose.raw_data` emits the hand keys **swapped** relative to the MediaPipe model
output: `right_hand_pose` holds the model's _left_-hand landmarks and
`left_hand_pose` holds the model's _right_-hand landmarks. This preserves the
legacy platform convention (`gosai-old` did the swap in its pose driver): the
SLR models were trained on that layout, the `slr_samples` correction files were
recorded under it, and `pose_to_mirror` anchors each hand to the matching wrist
landmark assuming it. Do not "fix" the swap without retraining/re-recording all
of those.

## `pose_to_mirror`

Projects MediaPipe landmarks onto an augmented mirror so the on-screen skeleton
lines up with the user's reflection, then maps the result into mirror pixel
space. Two paths, chosen by `set_mirror_config`:

- `mode: "direct"` — a webcam selfie overlay, no calibration.
- `mode: "reflection"` — the calibrated projection. Landmarks are placed in
  camera millimeters by `geometry.placement`, then projected from the viewer's
  eye onto the screen behind the mirror by `geometry.mirror_rig`. `lens`
  supplies the intrinsics, `rig` the mirror pose, and `trim_px` is a perceptual
  nudge added to every projected pixel. Without a `rig` there is no geometry:
  every landmark comes out invalid and the driver warns once.

- **Subscribes:** `pose.raw_data`
- **Emits:**
  - `mirrored_data` — landmarks in mirror pixel space (default `1080x1920`),
    smoothed by a One Euro filter timed on the frame's capture timestamp.
    Payload:
    `{ body_pose, right_hand_pose, left_hand_pose, face_mesh, body_world_pose, ts, capture_ts, latency_ms }`,
    each landmark `[x, y, depth_mm, visibility]`. A row the projection has no
    answer for reads `(-1, -1)`, and `-1` in its depth as well.
  - `projected_data` — reflection mode only, the same rows as canvas-centered
    screen millimeters before smoothing and before `trim_px`.
  - `viewer` — reflection mode only: both pupils in camera millimeters, where
    they came from (`face`, `body`, `none`), this visitor's `body_scale`, the
    `scale_cues` it was fused from (`eyes` and `floor`, each null until its
    window fills), and the eye midpoint's distance in front of the mirror.
- **Actions:**
  - `set_mirror_config` — change any of the settings in `MirrorSettings` and
    return all of them. Changing `mode`, `rig`, `lens`, the canvas size or
    `ipd_mm` drops the smoothing state and the visitor's size, which was
    estimated through the old ones.
  - `reset_viewer` — forget the visitor's size and the smoothing state, for the
    next person.

### Nobody is measured

The mirror stands in a public space, so no setting describes the person in
front of it: there is no chosen eye and no entered body size. The viewpoint is
always the eye midpoint, because a flat display can register with only one eye
at a time and nobody walking up to a mirror picks one.

Size is the one thing a single camera cannot see, and it matters: a depth off
by a factor `s` moves the drawing by `(s - 1)` times its distance on the glass
from the point nearest the camera, so 10 % costs about 6 cm at a hand by the
hip. Two cues estimate it per visitor, every frame:

- the pupils, through the assumed spacing `ipd_mm` (63 mm by default, the
  population prior). Adults spread about 5 % around it; children sit well below.
- the floor, when the rig profile carries a `camera_height_mm` and the feet are
  in the frame. A foot on a known plane has a depth that owes nothing to the
  person's size.

`placement.SessionScale` keeps a sliding median per cue and fuses them in the
log domain, weighted by how far each can be off for a stranger. It starts over
when no body arrived for a second, on `reset_viewer`, or when the eye midpoint
jumps more than 250 mm between two frames, which is another person walking in
while the tracker still holds the first. Landmarks outside the frame are
treated as unseen whatever visibility MediaPipe reports for them, because it
extrapolates feet below the image with a confident-looking score.

The error grows with distance on the glass from the camera, so a camera near
the middle of the drawn area beats one on top of it, and a camera low enough to
see feet gets the second cue for free.

In direct mode, `fit` decides what gives when the camera and the screen
disagree on aspect. `contain` (the default) keeps the whole frame and leaves a
band of the screen that no landmark can reach; `cover` crops the frame to the
screen so every on-screen position stays reachable. Apps whose UI is touched by
hand, second-self among them, ask for `cover`.

**Webcam-only (no RealSense).** The legacy driver needed an Intel RealSense
depth camera. We drop that hardware: MediaPipe Holistic already produces metric
3D (`body_world_pose`, meters), and the metric length a single camera still
needs comes from the two cues above. Hands keep their own relative depths,
anchored to the body's wrist.

## `mirror_calibration`

Runs the guided setup that produces the profiles `pose_to_mirror` consumes:
camera intrinsics from the printed ChArUco sheet, then the mirror rig's pose
from a handful of alignments. It stores nothing; the app saves the returned
`LensProfile` and `RigProfile`.

- **Depends on:** `camera`, `pose`
- **Subscribes:** `camera.frame`, `pose.raw_data`
- **Stages** (`set_stage`): `idle` detects nothing at all, `lens` collects
  views of the board, `align` records alignments. Detection only runs outside
  `idle`, so the driver is free to leave loaded.
- **Emits:**
  - `board` — the board in the latest frame outside `idle`: `detected`,
    `corners`, `marker_count`, `hull_px` for the preview overlay,
    `frame_width`, `frame_height`, `sharpness`, and when the pose was
    estimated `point_mm`, `distance_mm`, `rms_px`, `ambiguity_mm`, `tilt_deg`.
  - `lens_progress` — `views`, `coverage`, `tilted_views`, `progress`, `hint`
    and whether this frame was kept (`accepted`), in the `lens` stage.
- **Actions:** `configure` (partial settings update: `lens`, `hfov_deg`,
  `ipd_mm`, `eye`), `set_stage`, `reset_lens`, `solve_lens`,
  `capture_alignment`, `remove_alignment`, `clear_alignments`,
  `list_alignments`, `solve_rig`, `suggest_targets`, `check_rig`. A `configure`
  that changes the optics or the pupil spacing drops the recent history for the
  same reason a stage change does.

`suggest_targets` answers which of a list of canvas pixels the operator could
cover from where they stand, and how to hold the sheet for each (`corner_up`
upright, `corner_down` after half a turn). When it could test nothing it says
why in `reason`: `no_face` when no face has been seen yet, `too_close` when
there is no room to hold the board in front of the viewer. Before the fit it
runs on a nominal rig, so it is a guide; the capture itself still checks that
the board was seen.

`ipd_mm` and `eye` describe the calibration operator, who is not a member of
the public: they are given per run and never reach `pose_to_mirror`, which
measures nobody.

`capture_alignment` averages the short window that ended when the app called
it, which is the moment the operator confirms. Stillness alone never captures.
It refuses a sample with a machine-readable code in front of the message:
`board_missing:`, `face_missing:`, `unstable_board:`, `unstable_eye:` or
`ambiguous_board:`. The histories are cleared afterwards, so the next target
cannot reuse those frames. An operator working alone, with the keyboard on
another display, needs nothing more: the app calls the action when its
countdown ends and the window is the moment before that.

`solve_rig` grades the fit by `predicted_error_mm` (good <= 15 mm, fair <= 30
mm, poor beyond), never by the residuals: a set of alignments taken at a
single standing distance fits its own targets just as tightly as a good set
while leaving the rig loosely constrained. Mark a couple of alignments as
`holdout` to get an independent check in the same result, and use `check_rig`
later to score a saved calibration against every stored alignment. Its optional
`camera_height_mm` goes straight into the returned `RigProfile`, so the app
stores one object and `pose_to_mirror` gets the floor cue with it.

## `slr` (sign-language recognition)

Classifies a rolling window of pose frames into a sign label using the legacy
ONNX models.

- **Subscribes:** `pose.raw_data`
- **Emits:** `new_sign` — `{ guessed_sign: str, probability: float }`, once the
  30-frame window is full.
- **Actions:** `set_actions` — register the ordered list of sign labels; this
  also selects the model `slr_<num_actions>.onnx` and the feature layout.

**Feature layout** (per frame, flattened `(x, y)` pairs):

- `158` features → `face(4 landmarks: 10,152,234,454) + body(33) + right_hand(21) + left_hand(21)`
- `150` features → same without the face block

The model is chosen by `len(actions)`; logits are softmaxed and the argmax label
is emitted. Models are bundled as package data (`slr_models/*.onnx`, declared in
`python/pyproject.toml`) since they are not on a public CDN.

The models were trained on raw pixel landmarks from the legacy 640x480
camera. Live landmarks are mapped into that space **aspect-preserving**
(uniform scale, letterboxed/centered): per-axis stretching would squash body
proportions on any non-4:3 camera (a portrait-rotated camera compresses y by
~2.7x relative to x) and recognition degrades to noise.

## `ball` runtime backends

Training always runs in PyTorch (CUDA on NVIDIA, MPS/Metal on Apple) — TensorRT
and CoreML are **not** training backends, they are inference/export targets, so
there is only ever one trained model.

For inference, the driver ships a **single ONNX model** and runs it under the
fastest available ONNX Runtime _execution provider_. This keeps all the
pre/post-processing code shared and lets one artifact run everywhere:

| Host                | Auto backend                     | Notes                                 |
| ------------------- | -------------------------------- | ------------------------------------- |
| NVIDIA              | TensorRT EP → CUDA EP            | TensorRT compiles+caches on first run |
| Apple Silicon (mac) | CoreML EP (Neural Engine/GPU)    | falls back to CPU for unsupported ops |
| other               | CPU (only if explicitly allowed) | `GOSAI_ALLOW_CPU_FALLBACK=1`          |

Override with `GOSAI_ACCELERATOR=auto|tensorrt|cuda|coreml|dml|cpu`. TensorRT
caches engines under `GOSAI_TRT_CACHE_DIR` (default `~/.cache/gosai/trt`).

This EP approach captures most of the TensorRT/CoreML speedup with zero extra
runtime code or dependencies. If you want to benchmark the **native** engines
(marginally faster, but device/version-specific and heavier), export them too —
they are written to `training/models/<m>/exports/` and are not auto-installed:

```bash
cd training
# Native CoreML package (Apple):
uv run gosai-train --model ball export --formats onnx,coreml
# Native TensorRT engine (NVIDIA; Ultralytics installs tensorrt on demand):
uv run gosai-train --model ball export --formats onnx,engine
```
