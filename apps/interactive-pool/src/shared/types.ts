/**
 * Types shared by the interactive-pool layers.
 *
 * Every layer draws in a 1920x1080 reference space, the legacy projector
 * setup. With a calibration the ball and hand_pose drivers already emit
 * coordinates in that space, and the canvas maps it onto the window.
 */

import type { DriverTypes, FrameInfo, Layer, LayerDefinition } from '@gosai/sdk';

export const REF_WIDTH = 1920;
export const REF_HEIGHT = 1080;

/** A detected ball in reference-space pixels, with its velocity in px/s. */
export type Ball = DriverTypes.ball.Ball;

/** 21 MediaPipe landmarks as `[x, y, z?]`, x and y normalised to 0..1. */
export type Hand = DriverTypes.hand_pose.HandPosePayload['hands_landmarks'][number];

/** The latest tracking data, updated in place by the driver subscriptions. */
export interface Tracking {
  balls: readonly Ball[];
  /** `performance.now()` when `balls` last changed. */
  ballsUpdatedAt: number;
  /** Detection rate the ball driver reports. */
  ballFps: number;
  hands: readonly Hand[];
}

/** What every layer receives each frame. */
export interface PoolFrame extends FrameInfo {
  /** The canvas context, already transformed to reference space. */
  readonly ctx: CanvasRenderingContext2D;
  readonly tracking: Tracking;
}

export type PoolLayer = Layer<PoolFrame>;

export interface PoolLayerDefinition extends LayerDefinition<PoolFrame> {
  /** Lists the layer in the gesture menu, which starts and stops it. */
  readonly menu?: {
    readonly label: string;
    /** Stop the layer after a minute without hands on the table. */
    readonly autoStop?: boolean;
  };
}
