/**
 * Skeleton topology and drawing helpers for mirror-space landmarks.
 *
 * Connection tables are the MediaPipe hand (21-point), pose (33-point) and
 * face-mesh topologies ported verbatim from the legacy second-self components.
 * Landmarks arrive from the `pose_to_mirror` driver already mapped into
 * 1080x1920 reference space as `[x, y, depth, visibility]`.
 */

import { strokeLine } from './canvas.js';
import type { Landmark } from './types.js';

/** Hand connections grouped by finger (21-point MediaPipe topology). */
export const HAND_JUNCTIONS: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
  [
    [0, 1],
    [0, 5],
    [0, 9],
    [0, 13],
    [0, 17],
    [5, 9],
    [9, 13],
    [13, 17],
  ],
  [
    [1, 2],
    [2, 3],
    [3, 4],
  ],
  [
    [5, 6],
    [6, 7],
    [7, 8],
  ],
  [
    [9, 10],
    [10, 11],
    [11, 12],
  ],
  [
    [13, 14],
    [14, 15],
    [15, 16],
  ],
  [
    [17, 18],
    [18, 19],
    [19, 20],
  ],
];

/** Body connections grouped by head / mouth / torso+limbs (33-point topology). */
export const BODY_JUNCTIONS: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
  [
    [0, 1],
    [0, 4],
    [1, 2],
    [2, 3],
    [3, 7],
    [4, 5],
    [5, 6],
    [6, 8],
  ],
  [[9, 10]],
  [
    [11, 12],
    [11, 13],
    [11, 23],
    [12, 14],
    [12, 24],
    [13, 15],
    [14, 16],
    [15, 17],
    [15, 19],
    [15, 21],
    [16, 18],
    [16, 20],
    [16, 22],
    [17, 19],
    [18, 20],
    [23, 24],
    [23, 25],
    [24, 26],
    [25, 27],
    [26, 28],
    [27, 29],
    [27, 31],
    [28, 30],
    [28, 32],
  ],
];

/** Body landmark indices belonging to the head (used to optionally hide it). */
export const BODY_HEAD_INDICES: ReadonlySet<number> = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
/** Body landmark indices for hand/wrist detail (often hidden for a cleaner look). */
export const BODY_WRIST_INDICES: ReadonlySet<number> = new Set([17, 18, 19, 20, 21, 22]);

/**
 * Face-mesh polylines (lips, eyes, brows, oval). Each inner array is a flat
 * list of landmark indices arranged as repeated pairs, so consecutive pairs
 * (step of 2) form the polyline edges.
 */
export const FACE_JUNCTIONS: ReadonlyArray<readonly number[]> = [
  // Lips.
  [
    61, 146, 146, 91, 91, 181, 181, 84, 84, 17, 17, 314, 314, 405, 405, 321, 321, 375, 375, 291, 61,
    185, 185, 40, 40, 39, 39, 37, 37, 0, 0, 267, 267, 269, 269, 270, 270, 409, 409, 291, 78, 95, 95,
    88, 88, 178, 178, 87, 87, 14, 14, 317, 317, 402, 402, 318, 318, 324, 324, 308, 78, 191, 191, 80,
    80, 81, 81, 82, 82, 13, 13, 312, 312, 311, 311, 310, 310, 415, 415, 308,
  ],
  // Left eye.
  [
    33, 7, 7, 163, 163, 144, 144, 145, 145, 153, 153, 154, 154, 155, 155, 133, 33, 246, 246, 161,
    161, 160, 160, 159, 159, 158, 158, 157, 157, 173, 173, 133,
  ],
  // Left eyebrow.
  [46, 53, 53, 52, 52, 65, 65, 55, 70, 63, 63, 105, 105, 66, 66, 107],
  // Right eye.
  [
    263, 249, 249, 390, 390, 373, 373, 374, 374, 380, 380, 381, 381, 382, 382, 362, 263, 466, 466,
    388, 388, 387, 387, 386, 386, 385, 385, 384, 384, 398, 398, 362,
  ],
  // Right eyebrow.
  [276, 283, 283, 282, 282, 295, 295, 285, 300, 293, 293, 334, 334, 296, 296, 336],
  // Face oval.
  [
    10, 338, 338, 297, 297, 332, 332, 284, 284, 251, 251, 389, 389, 356, 356, 454, 454, 323, 323,
    361, 361, 288, 288, 397, 397, 365, 365, 379, 379, 378, 378, 400, 400, 377, 377, 152, 152, 148,
    148, 176, 176, 149, 149, 150, 150, 136, 136, 172, 172, 58, 58, 132, 132, 93, 93, 234, 234, 127,
    127, 162, 162, 21, 21, 54, 54, 103, 103, 67, 67, 109, 109, 10,
  ],
];

/** True when a landmark exists and is on-screen (y > 0 sentinel from legacy). */
export function isValid(lm: Landmark | undefined): lm is Landmark {
  return Array.isArray(lm) && lm.length >= 2 && lm[1]! > 0;
}

export interface SkeletonStyle {
  color?: string;
  weight?: number;
  /** Minimum visibility (component index 3) to draw a point's edges. */
  minVisibility?: number;
  drawPoints?: boolean;
  pointColor?: string;
  pointDiameter?: number;
}

/** Draw a hand skeleton (21-point) from grouped connections. */
export function drawHand(
  ctx: CanvasRenderingContext2D,
  pose: Landmark[],
  style: SkeletonStyle = {},
): void {
  if (pose.length < 21) return;
  const color = style.color ?? '#ffffff';
  const weight = style.weight ?? 4;
  for (const finger of HAND_JUNCTIONS) {
    for (const [a, b] of finger) {
      const pa = pose[a];
      const pb = pose[b];
      if (isValid(pa) && isValid(pb)) {
        strokeLine(ctx, pa[0]!, pa[1]!, pb[0]!, pb[1]!, weight, color);
      }
    }
  }
  if (style.drawPoints) {
    drawPoints(ctx, pose, style);
  }
}

export interface BodyStyle extends SkeletonStyle {
  showHead?: boolean;
  showWrist?: boolean;
}

/** Draw a body skeleton (33-point) honoring head/wrist visibility options. */
export function drawBody(
  ctx: CanvasRenderingContext2D,
  pose: Landmark[],
  style: BodyStyle = {},
): void {
  if (pose.length === 0) return;
  const color = style.color ?? '#ffffff';
  const weight = style.weight ?? 4;
  const minVis = style.minVisibility ?? 0.6;
  const showHead = style.showHead ?? false;
  const showWrist = style.showWrist ?? false;
  for (const group of BODY_JUNCTIONS) {
    for (const [a, b] of group) {
      const pa = pose[a];
      const pb = pose[b];
      if (!isValid(pa) || !isValid(pb)) continue;
      if ((pa[3] ?? 1) < minVis) continue;
      if (!showHead && (BODY_HEAD_INDICES.has(a) || BODY_HEAD_INDICES.has(b))) continue;
      if (!showWrist && (BODY_WRIST_INDICES.has(a) || BODY_WRIST_INDICES.has(b))) continue;
      strokeLine(ctx, pa[0]!, pa[1]!, pb[0]!, pb[1]!, weight, color);
    }
  }
}

/** Draw the face-mesh wireframe from the polyline tables. */
export function drawFace(
  ctx: CanvasRenderingContext2D,
  mesh: Landmark[],
  style: SkeletonStyle = {},
): void {
  if (mesh.length === 0) return;
  const color = style.color ?? '#ffffff';
  const weight = style.weight ?? 2;
  for (const poly of FACE_JUNCTIONS) {
    for (let i = 0; i + 1 < poly.length; i += 2) {
      const pa = mesh[poly[i]!];
      const pb = mesh[poly[i + 1]!];
      if (isValid(pa) && isValid(pb)) {
        strokeLine(ctx, pa[0]!, pa[1]!, pb[0]!, pb[1]!, weight, color);
      }
    }
  }
}

function drawPoints(ctx: CanvasRenderingContext2D, pose: Landmark[], style: SkeletonStyle): void {
  const pc = style.pointColor ?? '#c8c8c8';
  const d = style.pointDiameter ?? 10;
  ctx.fillStyle = pc;
  for (const lm of pose) {
    if (isValid(lm)) {
      ctx.beginPath();
      ctx.arc(lm[0]!, lm[1]!, d / 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}
