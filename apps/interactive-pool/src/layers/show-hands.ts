/**
 * Hand skeleton overlay.
 *
 * Renders each detected hand as a magenta skeleton: filled dots at every
 * landmark and lines connecting joints. Landmark coordinates from the
 * `hand_pose` driver are normalised (0..1); they are mapped onto the
 * reference space (1920x1080).
 *
 * The joint topology is the standard MediaPipe Hands graph:
 *  palm: 0-1, 0-5, 0-9, 0-13, 0-17, 5-9, 9-13, 13-17
 *  thumb: 1-2, 2-3, 3-4
 *  index: 5-6, 6-7, 7-8
 *  middle: 9-10, 10-11, 11-12
 *  ring: 13-14, 14-15, 15-16
 *  pinky: 17-18, 18-19, 19-20
 */

import { fillCircle, strokeLine } from '../shared/draw.js';
import {
  REF_HEIGHT,
  REF_WIDTH,
  type Hand,
  type PoolFrame,
  type PoolLayer,
} from '../shared/types.js';

const COLOR = '#ff00ff';
const LANDMARK_DIAMETER = 10;
const LINE_WEIGHT = 4;
const LANDMARK_COUNT = 21;

const HAND_JUNCTIONS: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [0, 5],
  [0, 9],
  [0, 13],
  [0, 17],
  [5, 9],
  [9, 13],
  [13, 17],
  [1, 2],
  [2, 3],
  [3, 4],
  [5, 6],
  [6, 7],
  [7, 8],
  [9, 10],
  [10, 11],
  [11, 12],
  [13, 14],
  [14, 15],
  [15, 16],
  [17, 18],
  [18, 19],
  [19, 20],
];

export function createShowHandsLayer(): PoolLayer {
  return {
    render({ ctx, tracking }: PoolFrame): void {
      for (const hand of tracking.hands) {
        if (hand.length === LANDMARK_COUNT) drawHand(ctx, hand);
      }
    },
  };
}

function drawHand(ctx: CanvasRenderingContext2D, hand: Hand): void {
  for (const [a, b] of HAND_JUNCTIONS) {
    const [ax = 0, ay = 0] = hand[a] ?? [];
    const [bx = 0, by = 0] = hand[b] ?? [];
    strokeLine(
      ctx,
      ax * REF_WIDTH,
      ay * REF_HEIGHT,
      bx * REF_WIDTH,
      by * REF_HEIGHT,
      LINE_WEIGHT,
      COLOR,
    );
  }
  for (const [x = 0, y = 0] of hand) {
    fillCircle(ctx, x * REF_WIDTH, y * REF_HEIGHT, LANDMARK_DIAMETER, COLOR);
  }
}
