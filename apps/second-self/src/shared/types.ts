/**
 * Shared types for the Second Self compositor and its layers.
 *
 * Every layer draws in a portrait 1080x1920 reference space (the augmented
 * mirror display). The `pose_to_mirror` driver emits landmarks already mapped
 * into this space, so layers treat coordinates as reference-space pixels. The
 * compositor fits the reference space onto the window each frame.
 */

import type { DriverEventData, Layer as SdkLayer } from '@gosai/sdk';

export const REF_WIDTH = 1080;
export const REF_HEIGHT = 1920;

/**
 * A single landmark: `[x, y, depth, visibility]` from `pose_to_mirror`,
 * `[x, y, visibility]` from raw `pose` data.
 */
export type Landmark = number[];

export type MirroredData = DriverEventData<'pose_to_mirror', 'mirrored_data'>;
export type RawPoseData = DriverEventData<'pose', 'raw_data'>;
export type FrequencyData = DriverEventData<'frequency_analysis', 'frequency'>;
export type SignData = DriverEventData<'slr', 'new_sign'>;

/** Per-frame context handed to every running layer's `render`. */
export interface FrameContext {
  /** Canvas 2D context, already transformed into the reference space. */
  readonly ctx: CanvasRenderingContext2D;
  /** `performance.now()` timestamp of this frame. */
  readonly timestamp: number;
  /** Milliseconds since the previous frame, capped by the runtime. */
  readonly deltaMs: number;
  /** Where the reference space sits in the window, in CSS pixels. */
  readonly viewport: Viewport;
}

/** A rectangle in CSS pixels. */
export interface Viewport {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * A self-contained visual module. Layers draw into the shared reference-space
 * context and read real-time data from the shared `MirrorFeed`.
 */
export type Layer = SdkLayer<FrameContext>;
