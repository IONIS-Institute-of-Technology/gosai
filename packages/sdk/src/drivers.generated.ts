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
  }

  /** Camera-projector calibration via ArUco markers. */
  export namespace calibration {
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
  }

  /** Hand gesture classification (geometric). */
  export namespace hand_sign {
    /** One `[label, confidence]` pair per hand, in `hand_pose` order. */
    export interface SignPayload {
      sign: [string, number][];
      ts: number;
    }
  }

  /** Emits a periodic tick event for plumbing tests. */
  export namespace heartbeat {
    export interface TickPayload {
      count: number;
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
      /** @default true */
      ok: boolean;
      name: string;
    }

    export interface Ok {
      /** @default true */
      ok: boolean;
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
  }

  /** Map MediaPipe landmarks onto an augmented mirror (webcam-only). */
  export namespace pose_to_mirror {
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
  }

  /** Sign-language recognition from pose sequences (ONNX). */
  export namespace slr {
    export interface SignPayload {
      guessed_sign: string;
      probability: number;
    }

    export interface Ok {
      /** @default true */
      ok: boolean;
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
  }

  /** Silero-VAD voice activity detection. */
  export namespace speech_activity_detection {
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
  }

  /** Speech-to-text via faster-whisper. */
  export namespace speech_to_text {
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
        result: DriverTypes.ball.Ok;
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
        result: DriverTypes.calibration.Ok;
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
        result: DriverTypes.interpolate.Ok;
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
  /** Map MediaPipe landmarks onto an augmented mirror (webcam-only). */
  pose_to_mirror: {
    config: undefined;
    events: {
      /** Landmarks in screen pixels, smoothed. */
      mirrored_data: DriverTypes.pose_to_mirror.MirroredPayload;
      /** Reflection mode only: landmarks on the mirror plane in mm. */
      projected_data: DriverTypes.pose_to_mirror.MirroredPayload;
    };
    actions: {
      /** Change settings and return all of them. */
      set_mirror_config: {
        params: null | DriverTypes.pose_to_mirror.MirrorSettingsUpdate;
        result: DriverTypes.pose_to_mirror.MirrorSettings;
      };
      /** Record recent pose frames for one calibration target. */
      capture_calibration_sample: {
        params: DriverTypes.pose_to_mirror.CaptureParams;
        result: DriverTypes.pose_to_mirror.CaptureResult;
      };
      /** Fit tilt, scale and the pixel affine to the captured samples. */
      solve_calibration: {
        params: null | DriverTypes.pose_to_mirror.SolveParams;
        result: DriverTypes.pose_to_mirror.SolveResult;
      };
      /** Drop all captured calibration samples. */
      clear_calibration_samples: {
        params: undefined;
        result: DriverTypes.pose_to_mirror.ClearResult;
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
        result: DriverTypes.slr.Ok;
      };
    };
  };
  /** Audio output via sounddevice. */
  speaker: {
    config: DriverTypes.speaker.SpeakerConfig;
    events: {
      /** Stream settings after each (re)open. */
      settings: DriverTypes.speaker.AudioSettingsPayload;
      /** The output device ran out of data. */
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
        result: DriverTypes.speaker.Ok;
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
      /** Score 16 kHz mono audio whose length is a multiple of 512 samples. */
      predict: {
        params: (number | number[])[] | DriverTypes.speech_activity_detection.PredictParams;
        result: DriverTypes.speech_activity_detection.PredictResult;
      };
      /** Clear the model state and the buffered stream. */
      reset: {
        params: undefined;
        result: DriverTypes.speech_activity_detection.Ok;
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
        result: DriverTypes.speech_to_text.TranscribeResult;
      };
      /** Load another Whisper model, such as `small.en` or `large-v3`. */
      set_model: {
        params: string;
        result: DriverTypes.speech_to_text.ModelResult;
      };
    };
  };
}
