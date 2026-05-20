/**
 * Shared types used across all interactive-pool layers.
 *
 * The "reference resolution" for all layer rendering is 1920x1080 (matching the
 * legacy projector setup). The ball driver emits coordinates already warped
 * into that space via the calibration homography, so layers can treat ball
 * coordinates as absolute reference-space pixels. The compositor scales the
 * reference space to the actual canvas size each frame.
 */

export const REF_WIDTH = 1920;
export const REF_HEIGHT = 1080;

/** A detected pool ball, in reference-space (1920x1080) pixels. */
export interface Ball {
  x: number;
  y: number;
  r: number;
}

/** Cue stick endpoints when detected. */
export interface CueData {
  detected: boolean;
  a: { x: number; y: number };
  b: { x: number; y: number };
}

/**
 * MediaPipe-style hand pose payload emitted by the `hand_pose` driver.
 *
 * `hands_landmarks` is `[handIndex][landmarkIndex] = [x, y, z?]` with `x` and
 * `y` normalised to 0..1 over the camera frame.
 *
 * Optional fields appear when paired drivers are active.
 */
export interface HandPosePayload {
  hands_landmarks?: number[][][];
  hands_handedness?: Array<[unknown, unknown, unknown]>;
  hands_sign?: Array<[string, ...unknown[]]>;
}

/** Shape we feed to layer renderers each frame. */
export interface FrameContext {
  /** Canvas drawing context. Already cleared by the compositor when relevant. */
  ctx: CanvasRenderingContext2D;
  /** Effective width in reference-space pixels (always REF_WIDTH). */
  refWidth: number;
  /** Effective height in reference-space pixels (always REF_HEIGHT). */
  refHeight: number;
  /** Timestamp of this frame, in ms (performance.now). */
  timestamp: number;
  /** Delta from previous frame, in ms. */
  deltaMs: number;
  /** Frame counter since experience start. */
  frameCount: number;
}

/**
 * Standard layer contract. A layer is a self-contained visual module managed
 * by the main orchestrator. Layers do not own their canvas; they draw into
 * the shared context provided each frame.
 */
export interface Layer {
  /** Optional async preload (load assets, etc). */
  preload?(): Promise<void>;
  /** Called when the layer becomes active. Sync or async. */
  start?(): void | Promise<void>;
  /** Called every frame while the layer is active. */
  render(frame: FrameContext): void;
  /** Called when the layer is deactivated. Must release listeners. */
  stop?(): void;
}

/** Snapshot of latest hand-pose data shared between layers (e.g. menu). */
export interface HandsSnapshot {
  /** For each detected hand, an array of 21 landmarks in 0..1 normalised coords. */
  hands: number[][][];
  /** Handedness labels, optional and parallel to `hands`. */
  handedness: Array<[unknown, unknown, unknown]>;
  /** Last update timestamp. */
  lastUpdate: number;
}

/** Snapshot of latest ball data shared between layers. */
export interface BallsSnapshot {
  /** Active ball positions in reference-space pixels. */
  balls: Ball[];
  /** Ball-driver FPS, if available. */
  fps: number;
  /** Last update timestamp. */
  lastUpdate: number;
}

/** Snapshot of latest cue data shared between layers. */
export interface CueSnapshot {
  /** Detection state and endpoints. */
  cue: CueData;
  /** Last update timestamp. */
  lastUpdate: number;
}
