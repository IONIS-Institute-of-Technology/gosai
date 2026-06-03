/**
 * Shared types for the Second Self compositor and its layers.
 *
 * The reference resolution for all rendering is portrait 1080x1920 (the legacy
 * augmented-mirror display). The `pose_to_mirror` driver emits landmarks
 * already mapped into this space, so layers treat coordinates as absolute
 * reference-space pixels. The compositor scales the reference space to the
 * actual canvas size each frame.
 */

export const REF_WIDTH = 1080;
export const REF_HEIGHT = 1920;

/**
 * A single landmark. The `pose_to_mirror` driver emits `[x, y, depth, vis]`;
 * raw `pose` data is `[x, y, vis]`. Accessors must tolerate both, so we keep
 * this as a numeric tuple with optional trailing components.
 */
export type Landmark = number[];

/** Payload emitted by the `pose_to_mirror` driver's `mirrored_data` event. */
export interface MirroredData {
  body_pose: Landmark[];
  /** MediaPipe right hand (handedness pre-swapped upstream for mirror view). */
  right_hand_pose: Landmark[];
  left_hand_pose: Landmark[];
  face_mesh: Landmark[];
  /** Metric 3D body landmarks `[x, y, z, vis]` (meters), passed through. */
  body_world_pose?: Landmark[];
  ts?: number;
}

/** Payload emitted by the `frequency_analysis` driver's `frequency` event. */
export interface FrequencyData {
  max_frequency: number;
  amplitude: number;
  rfft: number[];
  blocksize?: number;
  samplerate?: number;
}

/** Payload emitted by the `slr` driver's `new_sign` event. */
export interface SignData {
  guessed_sign: string;
  probability: number;
}

/** Per-frame context handed to every active layer's `render`. */
export interface FrameContext {
  /** Canvas 2D context, already transformed into 1080x1920 reference space. */
  ctx: CanvasRenderingContext2D;
  refWidth: number;
  refHeight: number;
  /** performance.now() timestamp of this frame. */
  timestamp: number;
  /** Milliseconds since the previous frame. */
  deltaMs: number;
  /** Frames since the experience started. */
  frameCount: number;
}

/**
 * A layer is a self-contained visual module. Layers never own a canvas; they
 * draw into the shared reference-space context provided each frame and read
 * real-time data from the shared {@link MirrorFeed}.
 */
export interface Layer {
  /** Optional async preload (load images/fonts/JSON). */
  preload?(): Promise<void>;
  /** Called when the layer becomes active. */
  start?(): void | Promise<void>;
  /** Called every frame while active. */
  render(frame: FrameContext): void;
  /** Called when deactivated. Must release any listeners/resources. */
  stop?(): void;
}
