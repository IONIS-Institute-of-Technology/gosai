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
- [`mirror_calibration`](#mirror_calibration): Lens and mirror-rig calibration from the printed ChArUco board.
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
| `set_homography`  | `number[]` | `null`             | Set the camera->output homography (9 values, row-major).            |
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
  /** Milliseconds since the Unix epoch. */
  ts: number;
  /** When the camera captured the frame, in milliseconds since the Unix epoch. */
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

export interface SizeResult {
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
| `clear`             | none                           | `null`              | Forget accumulated detections.                                                         |
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
  /** Milliseconds since the Unix epoch. */
  ts: number;
}

/** 3x3 matrices flattened row by row. */
export interface HomographyPayload {
  matrix: number[];
  inverse: number[];
  surface_matrix: number[] | null;
  surface_inverse: number[] | null;
  /** Milliseconds since the Unix epoch. */
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

export interface MarkerImage {
  id: number;
  size: number;
  png_base64: string;
}

export interface LatestFrame {
  jpeg_base64: string;
  /** @default null */
  width: number | null;
  /** @default null */
  height: number | null;
  /**
   * The frame's `ts`, in milliseconds since the Unix epoch.
   * @default null
   */
  ts: number | null;
}

export interface ReprojectedPoint {
  x: number;
  y: number;
}

export interface ReprojectedPoints {
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
| `set_focus`      | `FocusParams`               | `FocusStatus`          | Pin the focus, or restore autofocus with null. Applies without a reopen.  |
| `get_focus`      | none                        | `FocusStatus`          | The pinned focus and the device's focus control, when it has one.         |
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
  /** @default null */
  focus?: number | null;
}

export interface FramePayload {
  width: number;
  height: number;
  /** Milliseconds since the Unix epoch, equal to `capture_ts`. */
  ts: number;
  /** When the camera captured the frame, in milliseconds since the Unix epoch. */
  capture_ts: number;
  /** `time.perf_counter()` at capture in milliseconds, comparable only within the bridge process. */
  capture_perf: number;
  codec: string;
}

export interface ColorPayload {
  width: number;
  height: number;
  /** Milliseconds since the Unix epoch, equal to `capture_ts`. */
  ts: number;
  /** When the camera captured the frame, in milliseconds since the Unix epoch. */
  capture_ts: number;
  /** `time.perf_counter()` at capture in milliseconds, comparable only within the bridge process. */
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
  focus?: number | null;
}

export interface FocusParams {
  /** Device units, or null for autofocus. */
  focus: number | null;
}

export interface CameraFormats {
  device: number;
  formats: CameraFormat[];
  /** @default false */
  in_use: boolean;
  /** @default null */
  focus: null | FocusInfo;
}

export interface CameraFormat {
  width: number;
  height: number;
  fps: number[];
}

/** A device's `focus_absolute` control, in device units. */
export interface FocusInfo {
  min: number;
  max: number;
  step: number;
  default: number;
  /** Whether the device also has autofocus. */
  autofocus: boolean;
  /** @default null */
  autofocus_enabled: boolean | null;
  /**
   * Current focus. Under autofocus, where it last settled.
   * @default null
   */
  value: number | null;
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
  focus: number | null;
  codec: string;
}

export interface FocusStatus {
  supported: boolean;
  /** The pinned focus, or null under autofocus. */
  focus: number | null;
  /** @default null */
  info: null | FocusInfo;
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
  /** Milliseconds since the Unix epoch. */
  ts: number;
  /** When the camera captured the frame, in milliseconds since the Unix epoch. */
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
  /** @default false */
  cleared: boolean;
}

export interface SizeResult {
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
  /** Milliseconds since the Unix epoch. */
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
  /** Milliseconds since the Unix epoch. */
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
| `reset`              | `string \| null`    | `null`              | Forget the last value of one stream, or of every stream when null.        |

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
  name: string;
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
  /** When the block reached the driver, in milliseconds since the Unix epoch. */
  ts: number;
}

export interface AudioSettingsPayload {
  device: number | null;
  samplerate: number;
  channels: number;
  blocksize: number;
}

export interface InputDevices {
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

## mirror_calibration

Lens and mirror-rig calibration from the printed ChArUco board.

Starts `camera`, `pose` first. Exclusive: each app binding gets its own instance.

Types: `DriverTypes.mirror_calibration`.

### Events

| Event           | Payload               | Delivery | Description                                          |
| --------------- | --------------------- | -------- | ---------------------------------------------------- |
| `board`         | `BoardPayload`        | latest   | The printed board in the latest frame, outside idle. |
| `lens_progress` | `LensProgressPayload` | latest   | Lens capture progress, in the lens stage.            |

### Actions

| Action              | Params                              | Result                   | Description                                                                        |
| ------------------- | ----------------------------------- | ------------------------ | ---------------------------------------------------------------------------------- |
| `configure`         | `null \| CalibrationSettingsUpdate` | `CalibrationSettings`    | Change settings and return all of them. New optics drop the recent history.        |
| `set_stage`         | `StageParams`                       | `StageResult`            | Detect the board only outside 'idle'. Changing stage drops the recent history.     |
| `reset_lens`        | none                                | `null`                   | Forget the collected lens views.                                                   |
| `solve_lens`        | none                                | `LensResult`             | Solve the lens from the collected views; it also becomes the current lens setting. |
| `capture_alignment` | `CaptureAlignmentParams`            | `CaptureAlignmentResult` | Record one alignment from the window ending now. Raises with a reason code.        |
| `remove_alignment`  | `RemoveAlignmentParams`             | `AlignmentsResult`       | Drop one alignment by its index.                                                   |
| `clear_alignments`  | none                                | `AlignmentsResult`       | Drop every alignment.                                                              |
| `list_alignments`   | none                                | `AlignmentList`          | Every stored alignment, in capture order.                                          |
| `solve_rig`         | `SolveRigParams`                    | `SolveRigResult`         | Fit the mirror rig from the stored alignments.                                     |
| `suggest_targets`   | `SuggestTargetsParams`              | `SuggestTargetsResult`   | Which targets the operator can reach from where they stand, board still in view.   |
| `check_rig`         | `CheckRigParams`                    | `CheckRigResult`         | Residuals of every stored alignment against a given rig.                           |

### Types

```ts
/**
 * The printed board in the latest processed frame, in unflipped camera pixels.
 *
 * The pose fields are null when the board was not detected or its pose could
 * not be estimated. `distance_mm` is the range from the camera to the
 * designated corner, and `sharpness` only compares with other frames of the
 * same session.
 */
export interface BoardPayload {
  detected: boolean;
  corners: number;
  marker_count: number;
  hull_px: number[][];
  frame_width: number;
  frame_height: number;
  sharpness: number;
  point_mm: number[] | null;
  distance_mm: number | null;
  rms_px: number | null;
  ambiguity_mm: number | null;
  tilt_deg: number | null;
  /** When the camera captured the frame, in milliseconds since the Unix epoch. */
  capture_ts: number;
  /** Milliseconds since the Unix epoch. */
  ts: number;
}

/** How far the lens capture has got. `hint` is what is missing next. */
export interface LensProgressPayload {
  views: number;
  coverage: number;
  tilted_views: number;
  progress: number;
  hint: string;
  accepted: boolean;
  /** Milliseconds since the Unix epoch. */
  ts: number;
}

/** Settings to change; omitted fields keep their value. `lens: null` drops the lens. */
export interface CalibrationSettingsUpdate {
  lens?: null | LensProfile;
  hfov_deg?: number;
  /** Interpupillary distance of the operator, in mm. */
  ipd_mm?: number;
  eye?: 'left' | 'right';
}

/** Camera intrinsics for unflipped frames of `width` x `height`, after the camera's rotation. */
export interface LensProfile {
  width: number;
  height: number;
  fx: number;
  fy: number;
  cx: number;
  cy: number;
  /**
   * OpenCV order: k1, k2, p1, p2, k3, ...
   * @default []
   */
  dist?: number[];
  /** @default null */
  rms_px?: number | null;
}

export interface StageParams {
  stage: 'align' | 'idle' | 'lens';
}

export interface CaptureAlignmentParams {
  /** [x, y] of the target on the canvas, in pixels. */
  target_px: number[];
  /** [width, height] of the canvas, in pixels. */
  canvas_px: number[];
  /**
   * Keep this alignment out of the fit, to check it afterwards.
   * @default false
   */
  holdout?: boolean;
  /**
   * Length of the window ending at this call.
   * @default 600
   */
  window_ms?: number;
}

export interface RemoveAlignmentParams {
  index: number;
}

export interface SolveRigParams {
  /** Physical width the canvas pixels cover. */
  width_mm: number;
  /** Physical height the canvas pixels cover. */
  height_mm: number;
  /**
   * Mirror surface to pixel plane.
   * @default 0
   */
  gap_mm?: number;
  /**
   * Rough camera position (u, v, w) to start the fit from.
   * @default null
   */
  camera_in_screen_mm?: number[] | null;
  /**
   * Camera lens above the floor. Stored in the rig profile, where it lets a visitor's visible feet set their depth without knowing their size.
   * @default null
   */
  camera_height_mm?: number | null;
}

export interface SuggestTargetsParams {
  /** Canvas pixels to test. */
  candidates_px: number[][];
  canvas_px: number[];
  /** Physical width the canvas pixels cover. */
  width_mm: number;
  /** Physical height the canvas pixels cover. */
  height_mm: number;
  /** @default 0 */
  gap_mm?: number;
  /**
   * Rough camera position (u, v, w); ignored with `rig`.
   * @default null
   */
  camera_in_screen_mm?: number[] | null;
  /**
   * A fitted rig, once there is one; else a nominal one.
   * @default null
   */
  rig?: null | RigProfile;
  /**
   * How far in front of the eye the board is held.
   * @default 350
   */
  reach_mm?: number;
}

/** Pose of the canvas behind the mirror in camera coordinates. See `geometry.mirror_rig`. */
export interface RigProfile {
  /** Rotation vector; columns of the matrix are u, v, w. */
  rotation: number[];
  /** Canvas center in camera millimeters. */
  center_mm: number[];
  /** Physical width the canvas pixels cover. */
  width_mm: number;
  /** Physical height the canvas pixels cover. */
  height_mm: number;
  /**
   * Mirror surface to pixel plane.
   * @default 0
   */
  gap_mm?: number;
  /**
   * Camera lens above the floor, for a plumb mirror. Lets visible feet set a visitor's depth without knowing their size. Null turns that cue off.
   * @default null
   */
  camera_height_mm?: number | null;
  /**
   * Iris diameter to ASSUME on this camera, not anybody's real iris: the generic 11.7 mm times what this camera's landmark model reads it as. Measured on the operator during the rig calibration, so it travels with the rig.
   * @default 11.7
   */
  iris_mm?: number;
}

export interface CheckRigParams {
  rig: RigProfile;
}

/**
 * Every setting of the driver. Distances are millimeters.
 *
 * `ipd_mm` and `eye` describe the calibration operator, who is not a member
 * of the public: they are given per run and never reach `pose_to_mirror`.
 */
export interface CalibrationSettings {
  /** @default null */
  lens: null | LensProfile;
  /**
   * Fallback field of view when `lens` is unusable.
   * @default 60
   */
  hfov_deg: number;
  /**
   * Interpupillary distance of the operator, in mm.
   * @default 63
   */
  ipd_mm: number;
  /**
   * The eye the operator keeps open.
   * @default "right"
   */
  eye: 'left' | 'right';
}

export interface StageResult {
  stage: 'align' | 'idle' | 'lens';
}

export interface LensResult {
  lens: LensProfile;
  rms_px: number;
  views: number;
  hfov_deg: number;
}

export interface CaptureAlignmentResult {
  index: number;
  samples: number;
  holdouts: number;
  point_mm: number[];
  eye_mm: number[];
  board_spread_mm: number;
  eye_spread_mm: number;
  board_distance_mm: number;
  eye_distance_mm: number;
  /** Iris diameter the landmarks show for the operator, whose eye depth is metric because their pupil spacing was measured. Null when no iris was large enough in the image to read. */
  iris_mm: number | null;
}

export interface AlignmentsResult {
  samples: number;
  holdouts: number;
}

export interface AlignmentList {
  alignments: AlignmentSample[];
  samples: number;
  holdouts: number;
}

export interface AlignmentSample {
  index: number;
  target_px: number[];
  canvas_px: number[];
  holdout: boolean;
  point_mm: number[];
  eye_mm: number[];
  board_spread_mm: number;
  eye_spread_mm: number;
  board_distance_mm: number;
  eye_distance_mm: number;
  /** Iris diameter the landmarks show for the operator, whose eye depth is metric because their pupil spacing was measured. Null when no iris was large enough in the image to read. */
  iris_mm: number | null;
  ambiguity_mm: number;
  /** Milliseconds since the Unix epoch. */
  ts: number;
}

/**
 * The fitted rig and how much to trust it.
 *
 * `predicted_error_mm` and `condition` are null when the alignments leave the
 * pose entirely undetermined, which also makes `quality` poor.
 */
export interface SolveRigResult {
  rig: RigProfile;
  rms_mm: number;
  residuals_mm: SampleResidual[];
  predicted_error_mm: number | null;
  condition: number | null;
  quality: 'fair' | 'good' | 'poor';
  tilt_deg: number;
  camera_in_screen_mm: number[];
  distances_mm: number[];
  holdout: null | HoldoutReport;
  iris: IrisReport;
}

/** Distance on the screen between where the rig draws the corner and its target. */
export interface SampleResidual {
  index: number;
  error_mm: number | null;
}

export interface HoldoutReport {
  count: number;
  mean_mm: number | null;
  max_mm: number | null;
  residuals_mm: SampleResidual[];
}

/**
 * What the operator's irises read, and whether the reading depends on their range.
 *
 * `apparent_mm` is the median over every alignment that carried one, fitted
 * and holdout alike; the rig's `iris_mm` is that median shrunk toward the
 * population average. `near_mm` and `far_mm` split the same readings at their
 * median eye distance. A gap between them would mean the landmark model reads
 * an iris differently as it shrinks in the image, which only a rig trial can
 * show; nothing here corrects for it.
 */
export interface IrisReport {
  apparent_mm: number | null;
  near_mm: number | null;
  far_mm: number | null;
  /** Alignments that carried an iris reading. */
  samples: number;
}

/**
 * `reason` says why nothing could be tested: no face seen yet, or the
 * operator stands too close for a board held in front of them.
 */
export interface SuggestTargetsResult {
  targets: TargetSuggestion[];
  eye_distance_mm: number | null;
  /** @default null */
  reason: 'no_face' | 'too_close' | null;
}

/**
 * Whether the camera would still see the whole board with its corner on this target.
 *
 * `hold` says how to hold the sheet: `corner_up` is upright, the marked
 * corner at the top left; `corner_down` is the sheet turned half a turn, which
 * reaches targets low on the screen.
 */
export interface TargetSuggestion {
  target_px: number[];
  reachable: boolean;
  hold: 'corner_down' | 'corner_up' | null;
}

export interface CheckRigResult {
  samples: number;
  rms_mm: number | null;
  mean_mm: number | null;
  max_mm: number | null;
  residuals_mm: SampleResidual[];
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
 * Landmarks `[x_px, y_px, visibility]` in the full camera frame, mirrored when
 * `flipped`. `body_world_pose` rows are `[x_m, y_m, z_m, visibility]` from the hips.
 */
export interface RawPosePayload {
  face_mesh: number[][];
  body_pose: number[][];
  left_hand_pose: number[][];
  right_hand_pose: number[][];
  body_world_pose: number[][];
  frame_width: number;
  frame_height: number;
  /** Whether the landmarks sit in a horizontally flipped frame. */
  flipped: boolean;
  /** Milliseconds since the Unix epoch. */
  ts: number;
  /** When the camera captured the frame, in milliseconds since the Unix epoch. */
  capture_ts: number;
  inference_ms: number;
  frame_age_ms: number;
  latency_ms: number;
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

| Event            | Payload           | Delivery | Description                                                       |
| ---------------- | ----------------- | -------- | ----------------------------------------------------------------- |
| `mirrored_data`  | `MirroredPayload` | latest   | Landmarks in screen pixels, smoothed.                             |
| `projected_data` | `MirroredPayload` | latest   | Reflection mode only: landmarks in millimeters, before smoothing. |
| `viewer`         | `ViewerPayload`   | latest   | Reflection mode only: the viewer the projection assumes.          |

### Actions

| Action              | Params                         | Result           | Description                                         |
| ------------------- | ------------------------------ | ---------------- | --------------------------------------------------- |
| `set_mirror_config` | `null \| MirrorSettingsUpdate` | `MirrorSettings` | Change settings and return all of them.             |
| `reset_viewer`      | none                           | `null`           | Forget the viewer's body scale and smoothing state. |

### Types

```ts
/**
 * Landmarks as `[x, y, depth_mm, visibility]`.
 *
 * `mirrored_data` is canvas pixels, with `(-1, -1)` where the projection has
 * no answer. `depth_mm` is the distance in front of the mirror; direct mode
 * reports 0. A row with no answer reads `-1` in all three, because a depth
 * that is not a number cannot travel as one.
 *
 * `projected_data` carries the same rows as canvas-centered screen
 * millimeters, before `trim_px`.
 */
export interface MirroredPayload {
  body_pose: number[][];
  right_hand_pose: number[][];
  left_hand_pose: number[][];
  face_mesh: number[][];
  body_world_pose: number[][];
  /** Milliseconds since the Unix epoch. */
  ts: number;
  /** @default null */
  capture_ts?: number | null;
  /**
   * Milliseconds from capture to this payload.
   * @default null
   */
  latency_ms?: number | null;
}

/** Who the projection thinks is standing there. Diagnostics for the calibration wizard. */
export interface ViewerPayload {
  /** Viewer's left pupil in camera millimeters. */
  left_eye_mm: number[] | null;
  right_eye_mm: number[] | null;
  eye_source: 'body' | 'face' | 'none';
  /** This visitor's size against MediaPipe's average body. */
  body_scale: number;
  scale_cues: ScaleCues;
  /** Eye midpoint in front of the mirror, in millimeters. */
  distance_mm: number | null;
  capture_ts: number | null;
  /** Milliseconds since the Unix epoch. */
  ts: number;
}

/** Each size cue's median over its window, null while it has too few frames. */
export interface ScaleCues {
  /** From the pupil spacing assumed in `ipd_mm`. */
  eyes: number | null;
  /** From the apparent size of the irises, at the diameter the rig profile says to assume. Null when no iris is large enough in the image to read. */
  iris: number | null;
  /** From the visible feet standing on the known floor. */
  floor: number | null;
}

/**
 * Settings to change; omitted fields keep their value.
 *
 * `lens: null` and `rig: null` drop the calibration.
 */
export interface MirrorSettingsUpdate {
  mode?: 'direct' | 'reflection';
  fit?: 'contain' | 'cover';
  mirror?: boolean;
  face_mesh?: boolean;
  width?: number;
  height?: number;
  hfov_deg?: number;
  default_distance_mm?: number;
  zoom?: number;
  lens?: null | LensProfile;
  rig?: null | RigProfile;
  /** Assumed pupil spacing of the viewer, in mm. The population prior: the calibration operator pushes their own measured value while checking a fit. */
  ipd_mm?: number;
  /** [dx, dy] added to every projected pixel. */
  trim_px?: number[];
}

/** Camera intrinsics for unflipped frames of `width` x `height`, after the camera's rotation. */
export interface LensProfile {
  width: number;
  height: number;
  fx: number;
  fy: number;
  cx: number;
  cy: number;
  /**
   * OpenCV order: k1, k2, p1, p2, k3, ...
   * @default []
   */
  dist?: number[];
  /** @default null */
  rms_px?: number | null;
}

/** Pose of the canvas behind the mirror in camera coordinates. See `geometry.mirror_rig`. */
export interface RigProfile {
  /** Rotation vector; columns of the matrix are u, v, w. */
  rotation: number[];
  /** Canvas center in camera millimeters. */
  center_mm: number[];
  /** Physical width the canvas pixels cover. */
  width_mm: number;
  /** Physical height the canvas pixels cover. */
  height_mm: number;
  /**
   * Mirror surface to pixel plane.
   * @default 0
   */
  gap_mm?: number;
  /**
   * Camera lens above the floor, for a plumb mirror. Lets visible feet set a visitor's depth without knowing their size. Null turns that cue off.
   * @default null
   */
  camera_height_mm?: number | null;
  /**
   * Iris diameter to ASSUME on this camera, not anybody's real iris: the generic 11.7 mm times what this camera's landmark model reads it as. Measured on the operator during the rig calibration, so it travels with the rig.
   * @default 11.7
   */
  iris_mm?: number;
}

/** Every setting of the driver. Distances are millimeters. */
export interface MirrorSettings {
  /** @default "direct" */
  mode: 'direct' | 'reflection';
  /** @default "contain" */
  fit: 'contain' | 'cover';
  /** @default true */
  mirror: boolean;
  /** @default true */
  face_mesh: boolean;
  /** @default 1080 */
  width: number;
  /** @default 1920 */
  height: number;
  /** @default 60 */
  hfov_deg: number;
  /** @default 1500 */
  default_distance_mm: number;
  /** @default 1 */
  zoom: number;
  /** @default null */
  lens: null | LensProfile;
  /** @default null */
  rig: null | RigProfile;
  /**
   * Assumed pupil spacing of the viewer, in mm. The population prior: the calibration operator pushes their own measured value while checking a fit.
   * @default 63
   */
  ipd_mm: number;
  /** [dx, dy] added to every projected pixel. */
  trim_px: number[];
}
```

## slr

Sign-language recognition from pose sequences (ONNX).

Starts `pose` first. Exclusive: each app binding gets its own instance.

Types: `DriverTypes.slr`.

### Events

| Event      | Payload       | Delivery | Description                                    |
| ---------- | ------------- | -------- | ---------------------------------------------- |
| `new_sign` | `SignPayload` | latest   | Most likely sign over the last 30 pose frames. |

### Actions

| Action        | Params     | Result | Description                                                                |
| ------------- | ---------- | ------ | -------------------------------------------------------------------------- |
| `set_actions` | `string[]` | `null` | Register the sign labels, in model output order. Selects slr_<count>.onnx. |

### Types

```ts
export interface SignPayload {
  guessed_sign: string;
  probability: number;
}
```

## speaker

Audio output via sounddevice.

Exclusive: each app binding gets its own instance.

Types: `DriverTypes.speaker`.

Config: `SpeakerConfig`

### Events

| Event      | Payload                | Delivery | Description                                                             |
| ---------- | ---------------------- | -------- | ----------------------------------------------------------------------- |
| `settings` | `AudioSettingsPayload` | ordered  | Stream settings after each (re)open.                                    |
| `underrun` | `UnderrunPayload`      | ordered  | The output device ran out of data. At most once a second, with a count. |

### Actions

| Action           | Params                           | Result             | Description                                                                        |
| ---------------- | -------------------------------- | ------------------ | ---------------------------------------------------------------------------------- |
| `play`           | `(number \| number[])[] \| null` | `PlayResult`       | Queue samples in [-1, 1] at the stream's sample rate. Rows use their first column. |
| `clear`          | none                             | `null`             | Drop queued audio.                                                                 |
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
  /** Underruns since the previous event. */
  count: number;
  /** Milliseconds since the Unix epoch. */
  ts: number;
}

export interface PlayResult {
  queued: number;
  queued_samples: number;
}

export interface OutputDevices {
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
| `activity` | `ActivityPayload` | latest   | Speech probability of one 512-sample window. |

### Actions

| Action    | Params                                    | Result          | Description                                                                                                                            |
| --------- | ----------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `predict` | `(number \| number[])[] \| PredictParams` | `PredictResult` | Score 16 kHz mono audio whose length is a multiple of 512 samples, from a fresh state. Leaves the live stream alone and emits nothing. |
| `reset`   | none                                      | `null`          | Clear the live stream's model state and buffered audio.                                                                                |

### Types

```ts
export interface ActivityPayload {
  confidence: number;
  is_speech: boolean;
  /** Milliseconds since the Unix epoch. */
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
  /** Milliseconds since the Unix epoch. */
  ts: number;
  scores: number[];
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

| Action       | Params                                       | Result                 | Description                                                                 |
| ------------ | -------------------------------------------- | ---------------------- | --------------------------------------------------------------------------- |
| `transcribe` | `(number \| number[])[] \| TranscribeParams` | `TranscriptionPayload` | Transcribe 16 kHz mono audio: a sample list, or {audio_buffer} / {samples}. |
| `set_model`  | `string`                                     | `ModelResult`          | Load another Whisper model, such as `small.en` or `large-v3`.               |

### Types

```ts
export interface TranscriptionPayload {
  transcription: string;
  audio_duration_s: number;
  transcription_duration_s: number;
  /** Milliseconds since the Unix epoch. */
  ts: number;
}

export interface TranscribeParams {
  /** @default null */
  audio_buffer?: (number | number[])[] | null;
  /** @default null */
  samples?: (number | number[])[] | null;
}

export interface ModelResult {
  model: string;
}
```
