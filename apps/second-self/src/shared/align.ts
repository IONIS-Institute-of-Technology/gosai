/**
 * Fitting a recorded reference skeleton onto the live user, as the dance and
 * sign-training layers do: scale by the nose-to-hip distance, then line the
 * noses up.
 */

import { dist } from './ui.js';

export type Point2 = readonly [x: number, y: number];

export interface NoseHipFit {
  /** Reference pixels to user pixels. Always positive. */
  readonly ratio: number;
  readonly offsetX: number;
  readonly offsetY: number;
}

/** Nose-to-hip distances below this many pixels can't give a usable scale. */
const MIN_SPAN_PX = 1;

/**
 * The scale and offset that put the reference nose on the user's nose, with
 * the nose-to-hip distance matching. Null when either skeleton's nose and hip
 * coincide, which would make the scale zero or infinite.
 */
export function fitNoseHip(
  userNose: Point2,
  userHip: Point2,
  refNose: Point2,
  refHip: Point2,
): NoseHipFit | null {
  const userSpan = dist(userNose[0], userNose[1], userHip[0], userHip[1]);
  const refSpan = dist(refNose[0], refNose[1], refHip[0], refHip[1]);
  if (!(userSpan >= MIN_SPAN_PX) || !(refSpan >= MIN_SPAN_PX)) return null;
  const ratio = userSpan / refSpan;
  return {
    ratio,
    offsetX: userNose[0] - refNose[0] * ratio,
    offsetY: userNose[1] - refNose[1] * ratio,
  };
}
