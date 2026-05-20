# Phase 6 - Core Python Drivers

## Goal

Port the essential legacy drivers (hand_pose, hand_sign, pose, ball,
microphone, speaker, speech_to_text, speech_activity_detection,
frequency_analysis, interpolate) onto the new Python SDK, using the bridge's
JSON-line protocol instead of pickle + Redis.

## What landed

All drivers live under `python/src/gosai_py/drivers/` and are auto-discovered
by `gosai_py.bridge.Bridge.discover_builtin()`.

| Driver                       | Events                                      | Actions                                                                | Depends on    |
| ---------------------------- | ------------------------------------------- | ---------------------------------------------------------------------- | ------------- |
| `hand_pose`                  | `raw_data`                                  | `set_flip`, `set_window`                                               | `camera`      |
| `pose`                       | `raw_data`                                  | `set_flip`, `set_window`                                               | `camera`      |
| `hand_sign`                  | `sign`                                      | -                                                                      | `hand_pose`   |
| `ball`                       | `balls`, `fps`                              | `set_background`, `set_homography`, `set_output_size`, `set_min_area`, `set_threshold` | `camera`      |
| `microphone`                 | `audio_stream`, `settings`                  | `list_devices`, `set_device`, `set_samplerate`                         | -             |
| `speaker`                    | `settings`, `underrun`                      | `play`, `clear`, `list_devices`, `set_device`, `set_samplerate`        | -             |
| `speech_to_text`             | `transcription`                             | `transcribe`, `set_model`                                              | -             |
| `speech_activity_detection`  | `activity`                                  | `predict`                                                              | `microphone`  |
| `frequency_analysis`         | `frequency`                                 | `set_max_frequency`, `set_window_size`                                 | `microphone`  |
| `interpolate`                | `interpolated_data`                         | `interpolate_points`, `reset`                                          | -             |

The existing `camera`, `calibration`, `heartbeat` drivers from Phase 2/5 are
also still present (13 drivers total).

### Design choices

- **`BaseProcessor` for camera-driven CV drivers.** `hand_pose`, `pose`,
  `hand_sign`, `ball` and the audio drivers that follow another stream all
  subclass `BaseProcessor`, which centralises the subscribe/unsubscribe
  lifecycle. The driver author only writes `on_data(driver, event, data)`.

- **JPEG-base64 ingress, helper for decoding.** The camera publishes a
  base64-encoded JPEG (Phase 5). Downstream CV drivers decode with
  `gosai_py.serialization.jpeg_base64_to_frame`, which is a small wrapper
  around `cv2.imdecode`. This keeps the wire format JSON-friendly while
  staying efficient.

- **Geometric hand_sign classifier instead of an ONNX model.** The legacy
  driver bundles a proprietary 7 MB `handsign.onnx` we can't redistribute.
  Phase 6 ships a pure-Python rule-based classifier that recognizes the
  most-used legacy labels (FIST, OPEN_HAND, THUMB_UP/DOWN, INDEX, TWO,
  THREE, OK, PINCH) from MediaPipe landmarks. Per-rule confidence is a
  coarse heuristic, not a real probability.

- **Ball driver takes calibration data via actions.** The legacy driver
  hard-coded paths like `home/calibration_data.json` and
  `home/background.jpg`. The new driver receives them through dedicated
  actions (`set_background`, `set_homography`, `set_output_size`). Apps
  load them from the calibration app's storage and forward them in.

- **No Pickle / Redis anywhere.** All payloads are JSON-serializable.
  Frames and audio blocks are decoded to/from base64/JSON list inside the
  driver process.

- **STT does NOT auto-subscribe.** Whisper inference per audio block is
  wasteful. Apps drive it via `execute('transcribe', { audio_buffer })`
  whenever they decide an utterance is complete (typically gated by VAD).

- **VAD auto-classifies live mic frames only when sample-rate matches.**
  The driver checks for 16 kHz mono audio and logs a one-shot warning if
  the mic stream is at a different rate. Apps that resample inline can
  still call `predict` directly.

### Tests

- `python/tests/test_drivers_discovery.py` (new):
  - Confirms the bridge discovers all 13 drivers.
  - Verifies events/actions/dependencies are well-formed and dependencies
    point at real drivers.
  - Exercises the hand_sign geometric classifier on synthetic landmark
    data (FIST + OPEN_HAND).
  - Exercises the interpolate helper with shape-match and shape-mismatch
    cases.

- `packages/server/test/phase6-e2e.ts` (new):
  - End-to-end smoke that boots the real server, queries `/v1/drivers`
    over HTTP, and validates the full manifest against an expected table.

Both pass locally.

### Workspace changes outside `python/`

- `python/pyproject.toml`: added `torch`/`torchaudio`/`scipy` to the
  `speech` extra so STT + VAD pull their model runtime when explicitly
  opted into.

## Caveats / follow-ups

- **MediaPipe** is invoked off the main thread (each driver has its own
  worker thread). `mediapipe.solutions.hands.Hands` is not officially
  thread-safe across instances; we instantiate at most one per driver and
  the bridge only ever runs a single instance per driver name.
- **Silero VAD** loads on first use via `torch.hub.load(...,
  trust_repo=True)`. The first call hits the network. We don't ship a
  bundled copy yet; Phase 7 packaging should bake the model into the dist.
- **faster-whisper** model files are large and downloaded on first run.
  Phase 7 should either ship them or expose a setup step that pre-pulls
  them with a progress UI.
- **Hand sign classifier** is intentionally coarse. If a future app needs
  more nuanced gestures, we'll re-introduce a model file but it should
  live next to the app, not in the core.
