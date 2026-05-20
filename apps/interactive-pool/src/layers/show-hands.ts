/**
 * Hand skeleton overlay.
 *
 * Renders each detected hand as a magenta skeleton: filled dots at every
 * landmark and lines connecting joints. Landmark coordinates from the
 * `hand_pose` driver are normalised (0..1) over the camera frame; we map
 * them onto the reference-space canvas (1920x1080).
 *
 * The joint topology is the standard MediaPipe Hands graph:
 *  palm: 0-1, 0-5, 0-9, 0-13, 0-17, 5-9, 9-13, 13-17
 *  thumb: 1-2, 2-3, 3-4
 *  index: 5-6, 6-7, 7-8
 *  middle: 9-10, 10-11, 11-12
 *  ring: 13-14, 14-15, 15-16
 *  pinky: 17-18, 18-19, 19-20
 */

import { REF_HEIGHT, REF_WIDTH, type FrameContext, type Layer } from '../shared/types.js';
import { fillCircle, strokeLine } from '../shared/canvas-utils.js';
import type { PoolFeed } from '../shared/feed.js';

const COLOR = '#ff00ff';
const LANDMARK_DIAMETER = 10;
const LINE_WEIGHT = 4;

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

export function createShowHandsLayer(feed: PoolFeed): Layer {
  return {
    render(frame: FrameContext): void {
      const { ctx } = frame;
      for (const hand of feed.hands.hands) {
        if (!hand || hand.length !== 21) continue;
        drawHand(ctx, hand);
      }
    },
  };
}

function drawHand(ctx: CanvasRenderingContext2D, hand: number[][]): void {
  for (const [a, b] of HAND_JUNCTIONS) {
    const pa = hand[a];
    const pb = hand[b];
    if (!pa || !pb || pa.length < 2 || pb.length < 2) continue;
    strokeLine(
      ctx,
      pa[0]! * REF_WIDTH,
      pa[1]! * REF_HEIGHT,
      pb[0]! * REF_WIDTH,
      pb[1]! * REF_HEIGHT,
      LINE_WEIGHT,
      COLOR,
    );
  }
  for (const lm of hand) {
    if (!lm || lm.length < 2) continue;
    fillCircle(ctx, lm[0]! * REF_WIDTH, lm[1]! * REF_HEIGHT, LANDMARK_DIAMETER, COLOR);
  }
}
