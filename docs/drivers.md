# Driver reference

Generated from the Python driver schemas by `bun run drivers:types`. Do not edit.

Every driver an app uses is listed in its experience's `drivers` in `gosai.app.json`.
`@gosai/sdk` types these events and actions: `rt.drivers.on('pose', 'raw_data', (data) => ...)`
gets `DriverTypes.pose.RawPosePayload`, and `rt.drivers.execute` checks params and types
results. Apps with their own drivers generate the same types with `gosai-sdk gen-driver-types`,
see the [SDK README](../packages/sdk/README.md#driver-data).

**Delivery** says what happens when the app reads events slower than the driver sends them:
`latest` keeps only the newest value, `buffered (n)` keeps the last n values and
`ordered` delivers every value.

- [`ball`](#ball): YOLO-based ball detector (ONNX Runtime).
- [`calibration`](#calibration): Camera-projector calibration via ArUco markers.
- [`camera`](#camera): Webcam capture (OpenCV).
- [`frequency_analysis`](#frequency_analysis): FFT-based frequency estimation on a microphone stream.
- [`hand_pose`](#hand_pose): Hand landmark detection (MediaPipe Hands).
- [`hand_sign`](#hand_sign): Hand gesture classification (geometric).
- [`heartbeat`](#heartbeat): Emits a periodic tick event for plumbing tests.
- [`interpolate`](#interpolate): Smoothly interpolate any numeric stream over time.
- [`microphone`](#microphone): Audio input via sounddevice.
- [`pose`](#pose): Body, face and hand landmarks (MediaPipe Holistic Landmarker).
- [`pose_to_mirror`](#pose_to_mirror): Map MediaPipe landmarks onto an augmented mirror (webcam-only).
- [`slr`](#slr): Sign-language recognition from pose sequences (ONNX).
- [`speaker`](#speaker): Audio output via sounddevice.
- [`speech_activity_detection`](#speech_activity_detection): Silero-VAD voice activity detection.
- [`speech_to_text`](#speech_to_text): Speech-to-text via faster-whisper.

## ball

YOLO-based ball detector (ONNX Runtime).

Starts `camera` first. Exclusive: each app binding gets its own instance.

Types: `DriverTypes.ball`.

### Events

| Event   | Payload        | Delivery | Description                                  |
| ------- | -------------- | -------- | -------------------------------------------- |
| `balls` | `BallsPayload` | latest   | Balls tracked in the latest processed frame. |
| `fps`   | `FpsPayload`   | latest   | Detection rate over the last 50 frames.      |

### Actions

| Action            | Params     | Result             | Description                                                         |
| ----------------- | ---------- | ------------------ | ------------------------------------------------------------------- |
| `set_homography`  | `number[]` | `Ok`               | Set the camera->output homography (9 values, row-major).            |
| `set_output_size` | `Size`     | `SizeResult`       | Set the output size balls are kept within once a homography is set. |
| `set_confidence`  | `number`   | `ConfidenceResult` | Set the detection confidence threshold (clamped to 0.01..1).        |
| `set_max_ball_px` | `number`   | `MaxBallResult`    | Ignore detections larger than this, in camera pixels.               |
| `set_min_ball_px` | `number`   | `MinBallResult`    | Ignore detections smaller than this, in camera pixels.              |
| `set_frame_skip`  | `number`   | `FrameSkipResult`  | Run detection on one frame out of n + 1; 0 processes every frame.   |
| `set_cuda_device` | `number`   | `CudaDeviceResult` | Reload the model on another CUDA device.                            |

### Types

```ts
export interface BallsPayload {
  balls: Ball[];
  count: number;
  ts: number;
  capture_ts: number;
  frame_age_ms: number;
  latency_ms: number;
}

/** A tracked ball in output pixels. */
export interface Ball {
  x: number;
  y: number;
  diameter: number;
  vx: number;
  vy: number;
}

export interface FpsPayload {
  fps: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Ok {
  /** @default true */
  ok: boolean;
}

export interface SizeResult {
  /** @default true */
  ok: boolean;
  width: number;
  height: number;
}

export interface ConfidenceResult {
  confidence: number;
}

export interface MaxBallResult {
  max_ball_px: number;
}

export interface MinBallResult {
  min_ball_px: number;
}

export interface FrameSkipResult {
  frame_skip: number;
}

export interface CudaDeviceResult {
  cuda_device_id: number;
}
```

## calibration

Camera-projector calibration via ArUco markers.

Starts `camera` first. Exclusive: each app binding gets its own instance.

Types: `DriverTypes.calibration`.

### Events

| Event        | Payload             | Delivery | Description                                |
| ------------ | ------------------- | -------- | ------------------------------------------ |
| `detection`  | `DetectionPayload`  | latest   | Markers found in the latest frame.         |
| `homography` | `HomographyPayload` | ordered  | Matrices from the last successful compute. |
| `status`     | `StatusPayload`     | ordered  | Human-readable progress.                   |

### Actions

| Action              | Params                         | Result              | Description                                                                            |
| ------------------- | ------------------------------ | ------------------- | -------------------------------------------------------------------------------------- |
| `set_marker_layout` | `MarkerPlacement[]`            | `LayoutResult`      | Set where the markers are drawn on the display. Clears detections.                     |
| `set_camera_event`  | `null \| CameraEventParams`    | `CameraEventResult` | Detect markers in another event with `_frame` or `jpeg_base64` (default camera.frame). |
| `compute`           | `null \| ComputeParams`        | `ComputeResult`     | Compute the homographies from the current detections.                                  |
| `clear`             | none                           | `Ok`                | Forget accumulated detections.                                                         |
| `render_marker`     | `number \| RenderMarkerParams` | `MarkerImage`       | Render an ArUco marker as a PNG. Accepts {id, size} or a bare id.                      |
| `get_latest_frame`  | none                           | `LatestFrame`       | The latest camera frame as a base64 JPEG.                                              |
| `reproject_point`   | `ReprojectPointParams`         | `ReprojectedPoint`  | Warp a camera pixel into display or surface space. Fails when it maps to infinity.     |
| `reproject_points`  | `ReprojectPointsParams`        | `ReprojectedPoints` | Warp camera pixels into display or surface space, null where one maps to infinity.     |

### Types

```ts
export interface DetectionPayload {
  detected: number;
  ids: number[];
  corners: number[][][];
  ts: number;
}

/** 3x3 matrices flattened row by row. */
export interface HomographyPayload {
  matrix: number[];
  inverse: number[];
  surface_matrix: number[] | null;
  surface_inverse: number[] | null;
  ts: number;
}

export interface StatusPayload {
  stage: string;
  message: string;
}

/** Where the projector draws an ArUco marker, in display pixels. */
export interface MarkerPlacement {
  id: number;
  x: number;
  y: number;
  /** @default 60 */
  size?: number;
}

export interface CameraEventParams {
  /** @default null */
  driver?: string | null;
  /** @default null */
  event?: string | null;
}

export interface ComputeParams {
  /** @default null */
  focus_quad?: (number[] | Point)[] | null;
  /** @default null */
  surface_size?: null | Size;
  /** @default null */
  frame_size?: null | Size;
}

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface RenderMarkerParams {
  /** @default 0 */
  id?: number;
  /** @default 200 */
  size?: number;
}

export interface ReprojectPointParams {
  x: number;
  y: number;
  /** @default "display" */
  space?: 'display' | 'surface';
}

export interface ReprojectPointsParams {
  points: (number[] | Point)[];
  /** @default "display" */
  space?: 'display' | 'surface';
}

export interface LayoutResult {
  count: number;
}

export interface CameraEventResult {
  driver: string;
  event: string;
}

export interface ComputeResult {
  /** @default true */
  ok: boolean;
  matrix: number[];
  inverse: number[];
  surface_matrix: number[] | null;
  surface_inverse: number[] | null;
  /** The surface corners TL, TR, BR, BL in display pixels. Null without a focus quad, or when a corner maps to infinity on the display. */
  surface_quad_display: Point[] | null;
  surface_size: Size;
  frame_size: null | Size;
  samples: number;
  markers: number;
  inliers: number;
  reprojection_error_mean: number;
  reprojection_error_max: number;
}

export interface Ok {
  /** @default true */
  ok: boolean;
}

export interface MarkerImage {
  /** @default true */
  ok: boolean;
  id: number;
  size: number;
  png_base64: string;
}

export interface LatestFrame {
  /** @default true */
  ok: boolean;
  jpeg_base64: string;
  /** @default null */
  width: number | null;
  /** @default null */
  height: number | null;
  /** @default null */
  ts: number | null;
}

export interface ReprojectedPoint {
  /** @default true */
  ok: boolean;
  x: number;
  y: number;
}

export interface ReprojectedPoints {
  /** @default true */
  ok: boolean;
  points: (null | Point)[];
}
```

## camera

Webcam capture (OpenCV).

Exclusive: each app binding gets its own instance.

Types: `DriverTypes.camera`.

Config: `CameraConfig`

### Events

| Event        | Payload            | Delivery | Description                                             |
| ------------ | ------------------ | -------- | ------------------------------------------------------- |
| `frame`      | `FramePayload`     | latest   | Newest frame. In-process subscribers also get `_frame`. |
| `color`      | `ColorPayload`     | latest   | Newest frame as a base64 JPEG.                          |
| `frame_size` | `FrameSizePayload` | ordered  | Delivered mode after each (re)open.                     |
| `fps`        | `FpsPayload`       | ordered  | Publish rate, once a second.                            |

### Actions

| Action           | Params                      | Result                 | Description                                                               |
| ---------------- | --------------------------- | ---------------------- | ------------------------------------------------------------------------- |
| `list_formats`   | `null \| ListFormatsParams` | `CameraFormats`        | List the modes a device delivers. Works before the driver has started.    |
| `set_device`     | `number`                    | `DeviceResult`         | Switch to another camera device.                                          |
| `set_resolution` | `ResolutionParams`          | `ResolutionResult`     | Change the requested resolution. Omitted sides keep their value.          |
| `set_fps`        | `number`                    | `FpsResult`            | Change the target frame rate.                                             |
| `set_mode`       | `null \| ModeParams`        | `ModeResult`           | Change several settings with one reopen. Omitted fields keep their value. |
| `snapshot`       | none                        | `null \| ColorPayload` | The newest frame as a base64 JPEG, or null before the first frame.        |

### Types

```ts
export interface CameraConfig {
  /** @default 0 */
  device?: number;
  /** @default 1280 */
  width?: number;
  /** @default 720 */
  height?: number;
  /** @default 30 */
  fps?: number;
  /** @default 0 */
  rotation?: 0 | 90 | 180 | 270;
}

export interface FramePayload {
  width: number;
  height: number;
  ts: number;
  capture_ts: number;
  capture_perf: number;
  codec: string;
}

export interface ColorPayload {
  width: number;
  height: number;
  ts: number;
  capture_ts: number;
  capture_perf: number;
  codec: string;
  jpeg_base64: string;
  encode_ms: number;
}

export interface FrameSizePayload {
  width: number;
  height: number;
  fps: number;
  codec: string;
}

export interface FpsPayload {
  fps: number;
}

export interface ListFormatsParams {
  /** @default 0 */
  device?: number;
}

export interface ResolutionParams {
  /** @default null */
  width?: number | null;
  /** @default null */
  height?: number | null;
}

export interface ModeParams {
  /** @default null */
  device?: number | null;
  /** @default null */
  width?: number | null;
  /** @default null */
  height?: number | null;
  /** @default null */
  fps?: number | null;
  /** @default null */
  rotation?: 0 | 90 | 180 | 270 | null;
}

export interface CameraFormats {
  /** @default true */
  ok: boolean;
  device: number;
  formats: CameraFormat[];
  /** @default false */
  in_use: boolean;
}

export interface CameraFormat {
  width: number;
  height: number;
  fps: number[];
}

export interface DeviceResult {
  device: number;
}

export interface ResolutionResult {
  width: number;
  height: number;
}

export interface FpsResult {
  fps: number;
}

export interface ModeResult {
  device: number;
  width: number;
  height: number;
  fps: number;
  rotation: number;
  codec: string;
}
```

## frequency_analysis

FFT-based frequency estimation on a microphone stream.

Starts `microphone` first. Exclusive: each app binding gets its own instance.

Types: `DriverTypes.frequency_analysis`.

### Events

| Event       | Payload            | Delivery | Description                                    |
| ----------- | ------------------ | -------- | ---------------------------------------------- |
| `frequency` | `FrequencyPayload` | latest   | Spectrum of the latest window, once per block. |

### Actions

| Action              | Params   | Result               | Description                                                |
| ------------------- | -------- | -------------------- | ---------------------------------------------------------- |
| `set_max_frequency` | `number` | `MaxFrequencyResult` | Only report bins below this frequency (Hz).                |
| `set_window_size`   | `number` | `WindowSizeResult`   | Analyse this many consecutive blocks at once (at least 1). |

### Types

```ts
export interface FrequencyPayload {
  max_frequency: number;
  amplitude: number;
  rfft: number[];
  blocksize: number;
  samplerate: number;
}

export interface MaxFrequencyResult {
  max_frequency: number;
}

export interface WindowSizeResult {
  window_blocks: number;
}
```

## hand_pose

Hand landmark detection (MediaPipe Hands).

Starts `camera` first. Exclusive: each app binding gets its own instance.

Types: `DriverTypes.hand_pose`.

### Events

| Event      | Payload           | Delivery | Description                                 |
| ---------- | ----------------- | -------- | ------------------------------------------- |
| `raw_data` | `HandPosePayload` | latest   | Hand landmarks for the latest camera frame. |

### Actions

| Action             | Params             | Result             | Description                                                                    |
| ------------------ | ------------------ | ------------------ | ------------------------------------------------------------------------------ |
| `set_flip`         | `boolean`          | `FlipResult`       | Mirror frames horizontally before detection.                                   |
| `set_window`       | `number`           | `WindowResult`     | Detect only in a centered horizontal fraction of the frame (0.05 to 1).        |
| `set_homography`   | `number[] \| null` | `HomographyResult` | Set the camera->surface homography (9 values, row-major), or null to clear it. |
| `set_frame_size`   | `Size`             | `SizeResult`       | Pin the camera frame size the homography was computed for.                     |
| `set_surface_size` | `Size`             | `SizeResult`       | Set the surface size warped landmarks are normalised over.                     |

### Types

```ts
export interface HandPosePayload {
  hands_landmarks: number[][][];
  hands_handedness: [number, string, number][];
  ts: number;
  capture_ts: number;
  inference_ms: number;
  frame_age_ms: number;
  latency_ms: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface FlipResult {
  flip: boolean;
}

export interface WindowResult {
  window: number;
}

export interface HomographyResult {
  /** @default true */
  ok: boolean;
  /** @default false */
  cleared: boolean;
}

export interface SizeResult {
  /** @default true */
  ok: boolean;
  width: number;
  height: number;
}
```

## hand_sign

Hand gesture classification (geometric).

Starts `hand_pose` first. Exclusive: each app binding gets its own instance.

Types: `DriverTypes.hand_sign`.

### Events

| Event  | Payload       | Delivery | Description                                         |
| ------ | ------------- | -------- | --------------------------------------------------- |
| `sign` | `SignPayload` | latest   | Gesture of each hand in the latest hand_pose frame. |

### Actions

None.

### Types

```ts
/** One `[label, confidence]` pair per hand, in `hand_pose` order. */
export interface SignPayload {
  sign: [string, number][];
  ts: number;
}
```

## heartbeat

Emits a periodic tick event for plumbing tests.

Shared: every app uses the same instance.

Types: `DriverTypes.heartbeat`.

### Events

| Event  | Payload       | Delivery | Description                              |
| ------ | ------------- | -------- | ---------------------------------------- |
| `tick` | `TickPayload` | ordered  | Every half second, with a running count. |

### Actions

| Action | Params    | Result       | Description                                             |
| ------ | --------- | ------------ | ------------------------------------------------------- |
| `echo` | `unknown` | `EchoResult` | Return the data unchanged, with the current tick count. |

### Types

```ts
export interface TickPayload {
  count: number;
  now: number;
}

export interface EchoResult {
  echoed: unknown;
  count: number;
}
```

## interpolate

Smoothly interpolate any numeric stream over time.

Exclusive: each app binding gets its own instance.

Types: `DriverTypes.interpolate`.

### Events

| Event               | Payload               | Delivery | Description                           |
| ------------------- | --------------------- | -------- | ------------------------------------- |
| `interpolated_data` | `InterpolatedPayload` | ordered  | One step of a stream's interpolation. |

### Actions

| Action               | Params              | Result              | Description                                                               |
| -------------------- | ------------------- | ------------------- | ------------------------------------------------------------------------- |
| `interpolate_points` | `InterpolateParams` | `InterpolateResult` | Interpolate the stream `name` toward `points`, replacing its running job. |
| `reset`              | `string \| null`    | `Ok`                | Forget the last value of one stream, or of every stream when null.        |

### Types

```ts
export interface InterpolatedPayload {
  name: string;
  points: unknown[];
}

export interface InterpolateParams {
  /** @default "default" */
  name?: string;
  /** @default [] */
  points?: unknown[];
  /** @default 0.5 */
  factor?: number;
  /** @default 1 */
  depth?: number;
  /** @default 1 */
  amount?: number;
  /** @default 0 */
  duration?: number;
}

export interface InterpolateResult {
  /** @default true */
  ok: boolean;
  name: string;
}

export interface Ok {
  /** @default true */
  ok: boolean;
}
```

## microphone

Audio input via sounddevice.

Exclusive: each app binding gets its own instance.

Types: `DriverTypes.microphone`.

Config: `MicrophoneConfig`

### Events

| Event          | Payload                | Delivery      | Description                          |
| -------------- | ---------------------- | ------------- | ------------------------------------ |
| `audio_stream` | `AudioStreamPayload`   | buffered (64) | Every captured block, in order.      |
| `settings`     | `AudioSettingsPayload` | ordered       | Stream settings after each (re)open. |

### Actions

| Action           | Params           | Result             | Description                                                 |
| ---------------- | ---------------- | ------------------ | ----------------------------------------------------------- |
| `list_devices`   | none             | `InputDevices`     | List input devices.                                         |
| `set_device`     | `number \| null` | `DeviceResult`     | Capture from another device; null picks the system default. |
| `set_samplerate` | `number`         | `SamplerateResult` | Capture at another sample rate.                             |

### Types

```ts
export interface MicrophoneConfig {
  /** @default null */
  device?: number | null;
  /** @default null */
  samplerate?: number | null;
  /** @default null */
  channels?: number | null;
}

export interface AudioStreamPayload {
  block: number[][];
  samplerate: number;
  channels: number;
  blocksize: number;
  ts: number;
}

export interface AudioSettingsPayload {
  device: number | null;
  samplerate: number;
  channels: number;
  blocksize: number;
}

export interface InputDevices {
  /** @default true */
  ok: boolean;
  default_input: number | null;
  devices: InputDevice[];
}

export interface InputDevice {
  index: number;
  name: string;
  max_input_channels: number;
  default_samplerate: number;
}

export interface DeviceResult {
  device: number | null;
}

export interface SamplerateResult {
  samplerate: number;
}
```

## pose

Body, face and hand landmarks (MediaPipe Holistic Landmarker).

Starts `camera` first. Exclusive: each app binding gets its own instance.

Types: `DriverTypes.pose`.

Config: `PoseConfig`

### Events

| Event      | Payload          | Delivery | Description                            |
| ---------- | ---------------- | -------- | -------------------------------------- |
| `raw_data` | `RawPosePayload` | latest   | Landmarks for the latest camera frame. |

### Actions

| Action          | Params    | Result           | Description                                                             |
| --------------- | --------- | ---------------- | ----------------------------------------------------------------------- |
| `set_flip`      | `boolean` | `FlipResult`     | Mirror frames horizontally before detection.                            |
| `set_window`    | `number`  | `WindowResult`   | Detect only in a centered horizontal fraction of the frame (0.05 to 1). |
| `set_face_mesh` | `boolean` | `FaceMeshResult` | Send the face mesh to Node (in-process subscribers always get it).      |

### Types

```ts
export interface PoseConfig {
  /** @default false */
  flip?: boolean;
  /** @default 1 */
  window?: number;
  /** @default true */
  face_mesh?: boolean;
}

/**
 * Landmarks `[x_px, y_px, visibility]` in the full camera frame.
 * `body_world_pose` rows are `[x_m, y_m, z_m, visibility]` from the hips.
 */
export interface RawPosePayload {
  face_mesh: number[][];
  body_pose: number[][];
  left_hand_pose: number[][];
  right_hand_pose: number[][];
  body_world_pose: number[][];
  frame_width: number;
  frame_height: number;
  ts: number;
  inference_ms: number;
}

export interface FlipResult {
  flip: boolean;
}

export interface WindowResult {
  window: number;
}

export interface FaceMeshResult {
  face_mesh: boolean;
}
```

## pose_to_mirror

Map MediaPipe landmarks onto an augmented mirror (webcam-only).

Starts `pose` first. Exclusive: each app binding gets its own instance.

Types: `DriverTypes.pose_to_mirror`.

### Events

| Event            | Payload           | Delivery | Description                                                |
| ---------------- | ----------------- | -------- | ---------------------------------------------------------- |
| `mirrored_data`  | `MirroredPayload` | latest   | Landmarks in screen pixels, smoothed.                      |
| `projected_data` | `MirroredPayload` | latest   | Reflection mode only: landmarks on the mirror plane in mm. |

### Actions

| Action                       | Params                         | Result           | Description                                                   |
| ---------------------------- | ------------------------------ | ---------------- | ------------------------------------------------------------- |
| `set_mirror_config`          | `null \| MirrorSettingsUpdate` | `MirrorSettings` | Change settings and return all of them.                       |
| `capture_calibration_sample` | `CaptureParams`                | `CaptureResult`  | Record recent pose frames for one calibration target.         |
| `solve_calibration`          | `null \| SolveParams`          | `SolveResult`    | Fit tilt, scale and the pixel affine to the captured samples. |
| `clear_calibration_samples`  | none                           | `ClearResult`    | Drop all captured calibration samples.                        |

### Types

```ts
/**
 * Landmarks as `[x, y, depth_mm, visibility]`: pixels for `mirrored_data`,
 * mirror-plane millimeters for `projected_data`. Direct mode reports depth 0.
 */
export interface MirroredPayload {
  body_pose: number[][];
  right_hand_pose: number[][];
  left_hand_pose: number[][];
  face_mesh: number[][];
  body_world_pose: number[][];
  ts: number;
}

/** Settings to change; omitted fields keep their value. `affine: null` drops the fit. */
export interface MirrorSettingsUpdate {
  mode?: 'direct' | 'reflection';
  fit?: 'contain' | 'cover';
  mirror?: boolean;
  affine?: number[] | null;
  face_mesh?: boolean;
  x_offset?: number;
  y_offset?: number;
  screen_width_mm?: number;
  screen_height_mm?: number;
  width?: number;
  height?: number;
  tilt_deg?: number;
  mirror_offset_mm?: number;
  hfov_deg?: number;
  scale?: number;
  default_distance_mm?: number;
  zoom?: number;
}

export interface CaptureParams {
  /** [x_px, y_px] */
  target: number[];
  /** @default null */
  landmark?: number | null;
}

export interface SolveParams {
  /** @default true */
  apply?: boolean;
}

/** Every setting of the driver. Distances are millimeters. */
export interface MirrorSettings {
  /** @default "direct" */
  mode: 'direct' | 'reflection';
  /** @default "contain" */
  fit: 'contain' | 'cover';
  /** @default true */
  mirror: boolean;
  /** @default null */
  affine: number[] | null;
  /** @default true */
  face_mesh: boolean;
  /** @default -230 */
  x_offset: number;
  /** @default 100 */
  y_offset: number;
  /** @default 392.85 */
  screen_width_mm: number;
  /** @default 698.4 */
  screen_height_mm: number;
  /** @default 1080 */
  width: number;
  /** @default 1920 */
  height: number;
  /** @default 17 */
  tilt_deg: number;
  /** @default 0 */
  mirror_offset_mm: number;
  /** @default 60 */
  hfov_deg: number;
  /** @default 1 */
  scale: number;
  /** @default 1500 */
  default_distance_mm: number;
  /** @default 1 */
  zoom: number;
}

export interface CaptureResult {
  /** @default true */
  ok: boolean;
  samples: number;
  landmark: number;
  visibility: number;
}

export interface SolveResult {
  /** @default true */
  ok: boolean;
  tilt_deg: number;
  scale: number;
  affine: number[];
  residual_px_mean: number;
  residual_px_max: number;
  residuals_px: number[];
  samples: number;
  applied: boolean;
}

export interface ClearResult {
  /** @default true */
  ok: boolean;
  samples: number;
}
```

## slr

Sign-language recognition from pose sequences (ONNX).

Starts `pose` first. Exclusive: each app binding gets its own instance.

Types: `DriverTypes.slr`.

### Events

| Event      | Payload       | Delivery | Description                                    |
| ---------- | ------------- | -------- | ---------------------------------------------- |
| `new_sign` | `SignPayload` | ordered  | Most likely sign over the last 30 pose frames. |

### Actions

| Action        | Params     | Result | Description                                                                |
| ------------- | ---------- | ------ | -------------------------------------------------------------------------- |
| `set_actions` | `string[]` | `Ok`   | Register the sign labels, in model output order. Selects slr_<count>.onnx. |

### Types

```ts
export interface SignPayload {
  guessed_sign: string;
  probability: number;
}

export interface Ok {
  /** @default true */
  ok: boolean;
}
```

## speaker

Audio output via sounddevice.

Exclusive: each app binding gets its own instance.

Types: `DriverTypes.speaker`.

Config: `SpeakerConfig`

### Events

| Event      | Payload                | Delivery | Description                          |
| ---------- | ---------------------- | -------- | ------------------------------------ |
| `settings` | `AudioSettingsPayload` | ordered  | Stream settings after each (re)open. |
| `underrun` | `UnderrunPayload`      | ordered  | The output device ran out of data.   |

### Actions

| Action           | Params                           | Result             | Description                                                                        |
| ---------------- | -------------------------------- | ------------------ | ---------------------------------------------------------------------------------- |
| `play`           | `(number \| number[])[] \| null` | `PlayResult`       | Queue samples in [-1, 1] at the stream's sample rate. Rows use their first column. |
| `clear`          | none                             | `Ok`               | Drop queued audio.                                                                 |
| `list_devices`   | none                             | `OutputDevices`    | List output devices.                                                               |
| `set_device`     | `number \| null`                 | `DeviceResult`     | Play on another device; null picks the system default.                             |
| `set_samplerate` | `number`                         | `SamplerateResult` | Play at another sample rate.                                                       |

### Types

```ts
export interface SpeakerConfig {
  /** @default null */
  device?: number | null;
  /** @default null */
  samplerate?: number | null;
}

export interface AudioSettingsPayload {
  device: number | null;
  samplerate: number;
  channels: number;
  blocksize: number;
}

export interface UnderrunPayload {
  ts: number;
}

export interface PlayResult {
  /** @default true */
  ok: boolean;
  queued: number;
  queued_samples: number;
}

export interface Ok {
  /** @default true */
  ok: boolean;
}

export interface OutputDevices {
  /** @default true */
  ok: boolean;
  default_output: number | null;
  devices: OutputDevice[];
}

export interface OutputDevice {
  index: number;
  name: string;
  max_output_channels: number;
  default_samplerate: number;
}

export interface DeviceResult {
  device: number | null;
}

export interface SamplerateResult {
  samplerate: number;
}
```

## speech_activity_detection

Silero-VAD voice activity detection.

Starts `microphone` first. Exclusive: each app binding gets its own instance.

Types: `DriverTypes.speech_activity_detection`.

### Events

| Event      | Payload           | Delivery | Description                                  |
| ---------- | ----------------- | -------- | -------------------------------------------- |
| `activity` | `ActivityPayload` | ordered  | Speech probability of one 512-sample window. |

### Actions

| Action    | Params                                    | Result          | Description                                                        |
| --------- | ----------------------------------------- | --------------- | ------------------------------------------------------------------ |
| `predict` | `(number \| number[])[] \| PredictParams` | `PredictResult` | Score 16 kHz mono audio whose length is a multiple of 512 samples. |
| `reset`   | none                                      | `Ok`            | Clear the model state and the buffered stream.                     |

### Types

```ts
export interface ActivityPayload {
  confidence: number;
  is_speech: boolean;
  ts: number;
}

export interface PredictParams {
  /** @default null */
  audio_buffer?: (number | number[])[] | null;
  /** @default null */
  block?: (number | number[])[] | null;
}

export interface PredictResult {
  confidence: number;
  is_speech: boolean;
  ts: number;
  /** @default true */
  ok: boolean;
  scores: number[];
}

export interface Ok {
  /** @default true */
  ok: boolean;
}
```

## speech_to_text

Speech-to-text via faster-whisper.

Exclusive: each app binding gets its own instance.

Types: `DriverTypes.speech_to_text`.

### Events

| Event           | Payload                | Delivery | Description                      |
| --------------- | ---------------------- | -------- | -------------------------------- |
| `transcription` | `TranscriptionPayload` | ordered  | Text of each transcribed buffer. |

### Actions

| Action       | Params                                       | Result             | Description                                                                 |
| ------------ | -------------------------------------------- | ------------------ | --------------------------------------------------------------------------- |
| `transcribe` | `(number \| number[])[] \| TranscribeParams` | `TranscribeResult` | Transcribe 16 kHz mono audio: a sample list, or {audio_buffer} / {samples}. |
| `set_model`  | `string`                                     | `ModelResult`      | Load another Whisper model, such as `small.en` or `large-v3`.               |

### Types

```ts
export interface TranscriptionPayload {
  transcription: string;
  audio_duration_s: number;
  transcription_duration_s: number;
  ts: number;
}

export interface TranscribeParams {
  /** @default null */
  audio_buffer?: (number | number[])[] | null;
  /** @default null */
  samples?: (number | number[])[] | null;
}

export interface TranscribeResult {
  transcription: string;
  audio_duration_s: number;
  transcription_duration_s: number;
  ts: number;
  /** @default true */
  ok: boolean;
}

export interface ModelResult {
  model: string;
  ok: boolean;
}
```
