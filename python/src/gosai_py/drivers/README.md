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
  invalid (unknown `mode` or `fit`, an `affine` without 4 numbers, a
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
space.

- **Subscribes:** `pose.raw_data`
- **Emits:**
  - `mirrored_data` — landmarks in mirror pixel space (default `1080x1920`),
    temporally smoothed. Payload:
    `{ body_pose, right_hand_pose, left_hand_pose, face_mesh, body_world_pose, ts }`,
    each landmark `[x, y, depth_mm, visibility]`.
  - `projected_data` — same reflection but still in millimeters (pre
    pixel-mapping); useful for calibration/debugging.
- **Actions:**
  - `set_mirror_config` — change any of the settings in `MirrorSettings`,
    including the fitted `affine` (`[ax, bx, ay, by]` mm→px mapping) and
    `face_mesh` (false sends empty face meshes), and return all of them.
  - `capture_calibration_sample` — `{ target: [x_px, y_px], landmark? }`:
    snapshot the recent raw-pose frames for one calibration target (the user's
    index fingertip reflection aligned with a dot at `target`).
  - `solve_calibration` — grid-search `tilt_deg` × `scale` and least-squares
    the affine from the captured samples; applies the fit (unless
    `{"apply": false}`) and returns it with residuals in pixels. See
    `tests/test_pose_to_mirror_calibration.py` for a synthetic round trip.
  - `clear_calibration_samples` — drop captured samples.

Reflection-mode geometry is therefore _fitted_ by the second-self in-app
wizard, never measured by hand; the legacy mm config keys remain only as the
fallback used to derive the affine when no fit has been applied.

**Webcam-only (no RealSense).** The legacy driver needed an Intel RealSense
depth camera. We drop that hardware: MediaPipe Holistic already produces metric
3D (`body_world_pose`, meters), and absolute camera distance is recovered with a
weak-perspective estimate from shoulder span (metric vs. pixel size). Hands and
face are anchored to the nearest body joint's depth (the legacy `ref` trick).
The pinhole back-projection is numerically identical to the legacy RealSense
deprojection (which used zero distortion coefficients) — only the depth source
changed.

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
