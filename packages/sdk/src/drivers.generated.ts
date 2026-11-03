/**
 * Types of the built-in drivers, generated from their Python schemas by
 * `bun run drivers:types`. Do not edit.
 */

export declare namespace DriverTypes {
  /** YOLO-based ball detector (ONNX Runtime). */
  export namespace ball {
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
  }

  /** Camera-projector calibration via ArUco markers. */
  export namespace calibration {
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
  }

  /** Webcam capture (OpenCV). */
  export namespace camera {
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
  }

  /** FFT-based frequency estimation on a microphone stream. */
  export namespace frequency_analysis {
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
  }

  /** Hand landmark detection (MediaPipe Hands). */
  export namespace hand_pose {
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
  }

  /** Hand gesture classification (geometric). */
  export namespace hand_sign {
    /** One `[label, confidence]` pair per hand, in `hand_pose` order. */
    export interface SignPayload {
      sign: [string, number][];
      /** Milliseconds since the Unix epoch. */
      ts: number;
    }
  }

  /** Emits a periodic tick event for plumbing tests. */
  export namespace heartbeat {
    export interface TickPayload {
      count: number;
      /** Milliseconds since the Unix epoch. */
      now: number;
    }

    export interface EchoResult {
      echoed: unknown;
      count: number;
    }
  }

  /** Smoothly interpolate any numeric stream over time. */
  export namespace interpolate {
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
  }

  /** Audio input via sounddevice. */
  export namespace microphone {
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
  }

  /** Body, face and hand landmarks (MediaPipe Holistic Landmarker). */
  export namespace pose {
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
  }

  /** Sign-language recognition from pose sequences (ONNX). */
  export namespace slr {
    export interface SignPayload {
      guessed_sign: string;
      probability: number;
    }
  }

  /** Audio output via sounddevice. */
  export namespace speaker {
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
  }

  /** Silero-VAD voice activity detection. */
  export namespace speech_activity_detection {
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
  }

  /** Speech-to-text via faster-whisper. */
  export namespace speech_to_text {
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
  }
}

/** Event and action types of every built-in driver, by driver name. */
export interface BuiltinDrivers {
  /** YOLO-based ball detector (ONNX Runtime). */
  ball: {
    config: undefined;
    events: {
      /** Balls tracked in the latest processed frame. */
      balls: DriverTypes.ball.BallsPayload;
      /** Detection rate over the last 50 frames. */
      fps: DriverTypes.ball.FpsPayload;
    };
    actions: {
      /** Set the camera->output homography (9 values, row-major). */
      set_homography: {
        params: number[];
        result: null;
      };
      /** Set the output size balls are kept within once a homography is set. */
      set_output_size: {
        params: DriverTypes.ball.Size;
        result: DriverTypes.ball.SizeResult;
      };
      /** Set the detection confidence threshold (clamped to 0.01..1). */
      set_confidence: {
        params: number;
        result: DriverTypes.ball.ConfidenceResult;
      };
      /** Ignore detections larger than this, in camera pixels. */
      set_max_ball_px: {
        params: number;
        result: DriverTypes.ball.MaxBallResult;
      };
      /** Ignore detections smaller than this, in camera pixels. */
      set_min_ball_px: {
        params: number;
        result: DriverTypes.ball.MinBallResult;
      };
      /** Run detection on one frame out of n + 1; 0 processes every frame. */
      set_frame_skip: {
        params: number;
        result: DriverTypes.ball.FrameSkipResult;
      };
      /** Reload the model on another CUDA device. */
      set_cuda_device: {
        params: number;
        result: DriverTypes.ball.CudaDeviceResult;
      };
    };
  };
  /** Camera-projector calibration via ArUco markers. */
  calibration: {
    config: undefined;
    events: {
      /** Markers found in the latest frame. */
      detection: DriverTypes.calibration.DetectionPayload;
      /** Matrices from the last successful compute. */
      homography: DriverTypes.calibration.HomographyPayload;
      /** Human-readable progress. */
      status: DriverTypes.calibration.StatusPayload;
    };
    actions: {
      /** Set where the markers are drawn on the display. Clears detections. */
      set_marker_layout: {
        params: DriverTypes.calibration.MarkerPlacement[];
        result: DriverTypes.calibration.LayoutResult;
      };
      /** Detect markers in another event with `_frame` or `jpeg_base64` (default camera.frame). */
      set_camera_event: {
        params: null | DriverTypes.calibration.CameraEventParams;
        result: DriverTypes.calibration.CameraEventResult;
      };
      /** Compute the homographies from the current detections. */
      compute: {
        params: null | DriverTypes.calibration.ComputeParams;
        result: DriverTypes.calibration.ComputeResult;
      };
      /** Forget accumulated detections. */
      clear: {
        params: undefined;
        result: null;
      };
      /** Render an ArUco marker as a PNG. Accepts {id, size} or a bare id. */
      render_marker: {
        params: number | DriverTypes.calibration.RenderMarkerParams;
        result: DriverTypes.calibration.MarkerImage;
      };
      /** The latest camera frame as a base64 JPEG. */
      get_latest_frame: {
        params: undefined;
        result: DriverTypes.calibration.LatestFrame;
      };
      /** Warp a camera pixel into display or surface space. Fails when it maps to infinity. */
      reproject_point: {
        params: DriverTypes.calibration.ReprojectPointParams;
        result: DriverTypes.calibration.ReprojectedPoint;
      };
      /** Warp camera pixels into display or surface space, null where one maps to infinity. */
      reproject_points: {
        params: DriverTypes.calibration.ReprojectPointsParams;
        result: DriverTypes.calibration.ReprojectedPoints;
      };
    };
  };
  /** Webcam capture (OpenCV). */
  camera: {
    config: DriverTypes.camera.CameraConfig;
    events: {
      /** Newest frame. In-process subscribers also get `_frame`. */
      frame: DriverTypes.camera.FramePayload;
      /** Newest frame as a base64 JPEG. */
      color: DriverTypes.camera.ColorPayload;
      /** Delivered mode after each (re)open. */
      frame_size: DriverTypes.camera.FrameSizePayload;
      /** Publish rate, once a second. */
      fps: DriverTypes.camera.FpsPayload;
    };
    actions: {
      /** List the modes a device delivers. */
      list_formats: {
        params: null | DriverTypes.camera.ListFormatsParams;
        result: DriverTypes.camera.CameraFormats;
      };
      /** Switch to another camera device. */
      set_device: {
        params: number;
        result: DriverTypes.camera.DeviceResult;
      };
      /** Change the requested resolution. Omitted sides keep their value. */
      set_resolution: {
        params: DriverTypes.camera.ResolutionParams;
        result: DriverTypes.camera.ResolutionResult;
      };
      /** Change the target frame rate. */
      set_fps: {
        params: number;
        result: DriverTypes.camera.FpsResult;
      };
      /** Change several settings with one reopen. Omitted fields keep their value. */
      set_mode: {
        params: null | DriverTypes.camera.ModeParams;
        result: DriverTypes.camera.ModeResult;
      };
      /** Pin the focus, or restore autofocus with null. Applies without a reopen. */
      set_focus: {
        params: DriverTypes.camera.FocusParams;
        result: DriverTypes.camera.FocusStatus;
      };
      /** The pinned focus and the device's focus control, when it has one. */
      get_focus: {
        params: undefined;
        result: DriverTypes.camera.FocusStatus;
      };
      /** The newest frame as a base64 JPEG, or null before the first frame. */
      snapshot: {
        params: undefined;
        result: null | DriverTypes.camera.ColorPayload;
      };
    };
  };
  /** FFT-based frequency estimation on a microphone stream. */
  frequency_analysis: {
    config: undefined;
    events: {
      /** Spectrum of the latest window, once per block. */
      frequency: DriverTypes.frequency_analysis.FrequencyPayload;
    };
    actions: {
      /** Only report bins below this frequency (Hz). */
      set_max_frequency: {
        params: number;
        result: DriverTypes.frequency_analysis.MaxFrequencyResult;
      };
      /** Analyse this many consecutive blocks at once (at least 1). */
      set_window_size: {
        params: number;
        result: DriverTypes.frequency_analysis.WindowSizeResult;
      };
    };
  };
  /** Hand landmark detection (MediaPipe Hands). */
  hand_pose: {
    config: undefined;
    events: {
      /** Hand landmarks for the latest camera frame. */
      raw_data: DriverTypes.hand_pose.HandPosePayload;
    };
    actions: {
      /** Mirror frames horizontally before detection. */
      set_flip: {
        params: boolean;
        result: DriverTypes.hand_pose.FlipResult;
      };
      /** Detect only in a centered horizontal fraction of the frame (0.05 to 1). */
      set_window: {
        params: number;
        result: DriverTypes.hand_pose.WindowResult;
      };
      /** Set the camera->surface homography (9 values, row-major), or null to clear it. */
      set_homography: {
        params: number[] | null;
        result: DriverTypes.hand_pose.HomographyResult;
      };
      /** Pin the camera frame size the homography was computed for. */
      set_frame_size: {
        params: DriverTypes.hand_pose.Size;
        result: DriverTypes.hand_pose.SizeResult;
      };
      /** Set the surface size warped landmarks are normalised over. */
      set_surface_size: {
        params: DriverTypes.hand_pose.Size;
        result: DriverTypes.hand_pose.SizeResult;
      };
    };
  };
  /** Hand gesture classification (geometric). */
  hand_sign: {
    config: undefined;
    events: {
      /** Gesture of each hand in the latest hand_pose frame. */
      sign: DriverTypes.hand_sign.SignPayload;
    };
    actions: {};
  };
  /** Emits a periodic tick event for plumbing tests. */
  heartbeat: {
    config: undefined;
    events: {
      /** Every half second, with a running count. */
      tick: DriverTypes.heartbeat.TickPayload;
    };
    actions: {
      /** Return the data unchanged, with the current tick count. */
      echo: {
        params: unknown;
        result: DriverTypes.heartbeat.EchoResult;
      };
    };
  };
  /** Smoothly interpolate any numeric stream over time. */
  interpolate: {
    config: undefined;
    events: {
      /** One step of a stream's interpolation. */
      interpolated_data: DriverTypes.interpolate.InterpolatedPayload;
    };
    actions: {
      /** Interpolate the stream `name` toward `points`, replacing its running job. */
      interpolate_points: {
        params: DriverTypes.interpolate.InterpolateParams;
        result: DriverTypes.interpolate.InterpolateResult;
      };
      /** Forget the last value of one stream, or of every stream when null. */
      reset: {
        params: string | null;
        result: null;
      };
    };
  };
  /** Audio input via sounddevice. */
  microphone: {
    config: DriverTypes.microphone.MicrophoneConfig;
    events: {
      /** Every captured block, in order. */
      audio_stream: DriverTypes.microphone.AudioStreamPayload;
      /** Stream settings after each (re)open. */
      settings: DriverTypes.microphone.AudioSettingsPayload;
    };
    actions: {
      /** List input devices. */
      list_devices: {
        params: undefined;
        result: DriverTypes.microphone.InputDevices;
      };
      /** Capture from another device; null picks the system default. */
      set_device: {
        params: number | null;
        result: DriverTypes.microphone.DeviceResult;
      };
      /** Capture at another sample rate. */
      set_samplerate: {
        params: number;
        result: DriverTypes.microphone.SamplerateResult;
      };
    };
  };
  /** Body, face and hand landmarks (MediaPipe Holistic Landmarker). */
  pose: {
    config: DriverTypes.pose.PoseConfig;
    events: {
      /** Landmarks for the latest camera frame. */
      raw_data: DriverTypes.pose.RawPosePayload;
    };
    actions: {
      /** Mirror frames horizontally before detection. */
      set_flip: {
        params: boolean;
        result: DriverTypes.pose.FlipResult;
      };
      /** Detect only in a centered horizontal fraction of the frame (0.05 to 1). */
      set_window: {
        params: number;
        result: DriverTypes.pose.WindowResult;
      };
      /** Send the face mesh to Node (in-process subscribers always get it). */
      set_face_mesh: {
        params: boolean;
        result: DriverTypes.pose.FaceMeshResult;
      };
    };
  };
  /** Sign-language recognition from pose sequences (ONNX). */
  slr: {
    config: undefined;
    events: {
      /** Most likely sign over the last 30 pose frames. */
      new_sign: DriverTypes.slr.SignPayload;
    };
    actions: {
      /** Register the sign labels, in model output order. Selects slr_<count>.onnx. */
      set_actions: {
        params: string[];
        result: null;
      };
    };
  };
  /** Audio output via sounddevice. */
  speaker: {
    config: DriverTypes.speaker.SpeakerConfig;
    events: {
      /** Stream settings after each (re)open. */
      settings: DriverTypes.speaker.AudioSettingsPayload;
      /** The output device ran out of data. At most once a second, with a count. */
      underrun: DriverTypes.speaker.UnderrunPayload;
    };
    actions: {
      /** Queue samples in [-1, 1] at the stream's sample rate. Rows use their first column. */
      play: {
        params: (number | number[])[] | null;
        result: DriverTypes.speaker.PlayResult;
      };
      /** Drop queued audio. */
      clear: {
        params: undefined;
        result: null;
      };
      /** List output devices. */
      list_devices: {
        params: undefined;
        result: DriverTypes.speaker.OutputDevices;
      };
      /** Play on another device; null picks the system default. */
      set_device: {
        params: number | null;
        result: DriverTypes.speaker.DeviceResult;
      };
      /** Play at another sample rate. */
      set_samplerate: {
        params: number;
        result: DriverTypes.speaker.SamplerateResult;
      };
    };
  };
  /** Silero-VAD voice activity detection. */
  speech_activity_detection: {
    config: undefined;
    events: {
      /** Speech probability of one 512-sample window. */
      activity: DriverTypes.speech_activity_detection.ActivityPayload;
    };
    actions: {
      /** Score 16 kHz mono audio whose length is a multiple of 512 samples, from a fresh state. Leaves the live stream alone and emits nothing. */
      predict: {
        params: (number | number[])[] | DriverTypes.speech_activity_detection.PredictParams;
        result: DriverTypes.speech_activity_detection.PredictResult;
      };
      /** Clear the live stream's model state and buffered audio. */
      reset: {
        params: undefined;
        result: null;
      };
    };
  };
  /** Speech-to-text via faster-whisper. */
  speech_to_text: {
    config: undefined;
    events: {
      /** Text of each transcribed buffer. */
      transcription: DriverTypes.speech_to_text.TranscriptionPayload;
    };
    actions: {
      /** Transcribe 16 kHz mono audio: a sample list, or {audio_buffer} / {samples}. */
      transcribe: {
        params: (number | number[])[] | DriverTypes.speech_to_text.TranscribeParams;
        result: DriverTypes.speech_to_text.TranscriptionPayload;
      };
      /** Load another Whisper model, such as `small.en` or `large-v3`. */
      set_model: {
        params: string;
        result: DriverTypes.speech_to_text.ModelResult;
      };
    };
  };
}
