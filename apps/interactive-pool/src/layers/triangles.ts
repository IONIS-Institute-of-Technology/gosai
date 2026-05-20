/**
 * Triangle geometry visualizer (faithful port of
 * `triangles_remarkable_lines`).
 *
 * Detected balls are grouped into up to three triangles (vertices 0-1-2,
 * 3-4-5, 6-7-8). Four ball-activated toggle buttons sit along the left
 * edge of the table; covering a button with a ball turns its feature on:
 *
 *   button 0: triangle sides + angle labels
 *   button 1: centroid + medians
 *   button 2: perpendicular bisectors + circumcenter
 *   button 3: circumscribed circle
 *
 * Right triangles (any angle == 90) draw in blue instead of white.
 */

import { type FrameContext, type Layer } from '../shared/types.js';
import { strokeLine, strokeRect } from '../shared/canvas-utils.js';
import { dist, lineIntersection, mirror, midpoint, perpendicularExtremity, triangleAngleDeg, type Vec2 } from '../shared/math.js';
import type { PoolFeed } from '../shared/feed.js';

const MAX_TRIANGLES = 3;

/** Button rectangles [x, y, w, h] in reference-space pixels. */
const BUTTON_COORDS: ReadonlyArray<readonly [number, number, number, number]> = [
  [120, 555, 55, 55],
  [120, 430, 55, 55],
  [120, 305, 55, 55],
  [120, 180, 55, 55],
];

const WHITE = '#ffffff';
const RIGHT_BLUE = '#00aaff';
const CENTROID_YELLOW = '#ffff00';
const BISECTOR_MAGENTA = '#ff00ff';

interface DerivedTriangle {
  a: Vec2;
  b: Vec2;
  c: Vec2;
  angleA: number;
  angleB: number;
  angleC: number;
  centroid: Vec2;
  midAB: Vec2;
  midBC: Vec2;
  midCA: Vec2;
  perpExtAB: Vec2;
  perpExtAB_mirror: Vec2;
  perpExtBC: Vec2;
  perpExtBC_mirror: Vec2;
  perpExtCA: Vec2;
  perpExtCA_mirror: Vec2;
  circumcenter: Vec2;
  isRight: boolean;
}

export function createTrianglesLayer(feed: PoolFeed): Layer {
  return {
    render(frame: FrameContext): void {
      const { ctx } = frame;

      // Toggle state for the four feature buttons: ON while any ball covers
      // the button rectangle that frame.
      const boxes = [false, false, false, false];
      const vertices: Vec2[] = [];
      for (const ball of feed.balls.balls) {
        let hit = false;
        for (let i = 0; i < BUTTON_COORDS.length; i++) {
          const [bx, by, bw, bh] = BUTTON_COORDS[i]!;
          if (ball.x >= bx && ball.x <= bx + bw && ball.y >= by && ball.y <= by + bh) {
            boxes[i] = true;
            hit = true;
            break;
          }
        }
        if (!hit) vertices.push({ x: ball.x, y: ball.y });
      }

      drawButtons(ctx, boxes);

      const triCount = Math.min(MAX_TRIANGLES, Math.floor(vertices.length / 3));
      const triangles: DerivedTriangle[] = [];
      for (let i = 0; i < triCount; i++) {
        const a = vertices[i * 3];
        const b = vertices[i * 3 + 1];
        const c = vertices[i * 3 + 2];
        if (!a || !b || !c) continue;
        triangles.push(derive(a, b, c));
      }

      // Feature draws happen in the legacy order so overlapping elements
      // (e.g. circle behind triangle sides) layer naturally.
      if (boxes[3]) for (const t of triangles) drawCircumcircle(ctx, t);
      if (boxes[0]) {
        for (const t of triangles) {
          drawSides(ctx, t);
          drawAngleLabels(ctx, t);
        }
      }
      if (boxes[1]) {
        for (const t of triangles) {
          drawCentroidAndMedians(ctx, t);
        }
      }
      if (boxes[2]) {
        for (const t of triangles) {
          drawPerpendicularBisectors(ctx, t);
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

function drawButtons(ctx: CanvasRenderingContext2D, boxes: readonly boolean[]): void {
  for (let i = 0; i < BUTTON_COORDS.length; i++) {
    const [x, y, w, h] = BUTTON_COORDS[i]!;
    const colour = boxes[i] ? '#00ff00' : WHITE;
    strokeRect(ctx, x, y, w, h, 5, colour);
  }
}

// ---------------------------------------------------------------------------
// Derive geometry from three vertices
// ---------------------------------------------------------------------------

function derive(a: Vec2, b: Vec2, c: Vec2): DerivedTriangle {
  const angleA = triangleAngleDeg(c, a, b);
  const angleB = triangleAngleDeg(a, b, c);
  const angleC = triangleAngleDeg(b, c, a);

  const centroid: Vec2 = { x: (a.x + b.x + c.x) / 3, y: (a.y + b.y + c.y) / 3 };

  const midAB = midpoint(a, b);
  const midBC = midpoint(b, c);
  const midCA = midpoint(c, a);

  const perpExtAB = perpendicularExtremity(midAB, b);
  const perpExtAB_mirror = mirror(perpExtAB, midAB);
  const perpExtBC = perpendicularExtremity(midBC, c);
  const perpExtBC_mirror = mirror(perpExtBC, midBC);
  const perpExtCA = perpendicularExtremity(midCA, a);
  const perpExtCA_mirror = mirror(perpExtCA, midCA);

  const cc =
    lineIntersection(perpExtAB, perpExtAB_mirror, perpExtBC, perpExtBC_mirror) ??
    centroid;

  return {
    a,
    b,
    c,
    angleA,
    angleB,
    angleC,
    centroid,
    midAB,
    midBC,
    midCA,
    perpExtAB,
    perpExtAB_mirror,
    perpExtBC,
    perpExtBC_mirror,
    perpExtCA,
    perpExtCA_mirror,
    circumcenter: cc,
    isRight: angleA === 90 || angleB === 90 || angleC === 90,
  };
}

// ---------------------------------------------------------------------------
// Drawing primitives for each feature
// ---------------------------------------------------------------------------

function drawSides(ctx: CanvasRenderingContext2D, t: DerivedTriangle): void {
  const colour = t.isRight ? RIGHT_BLUE : WHITE;
  strokeLine(ctx, t.a.x, t.a.y, t.b.x, t.b.y, 5, colour);
  strokeLine(ctx, t.a.x, t.a.y, t.c.x, t.c.y, 5, colour);
  strokeLine(ctx, t.b.x, t.b.y, t.c.x, t.c.y, 5, colour);
}

function drawAngleLabels(ctx: CanvasRenderingContext2D, t: DerivedTriangle): void {
  const distance = 60;
  ctx.fillStyle = WHITE;
  labelAt(ctx, `${t.angleA}\u00b0`, t.a, t.centroid, distance);
  labelAt(ctx, `${t.angleB}\u00b0`, t.b, t.centroid, distance);
  labelAt(ctx, `${t.angleC}\u00b0`, t.c, t.centroid, distance);
}

function labelAt(
  ctx: CanvasRenderingContext2D,
  text: string,
  vertex: Vec2,
  centroid: Vec2,
  d: number,
): void {
  const x = vertex.x < centroid.x ? vertex.x - d : vertex.x + d;
  const y = vertex.y < centroid.y ? vertex.y - d : vertex.y + d;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(Math.PI);
  ctx.font = 'bold 48px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 0, 0);
  ctx.restore();
}

function drawCentroidAndMedians(ctx: CanvasRenderingContext2D, t: DerivedTriangle): void {
  ctx.strokeStyle = CENTROID_YELLOW;
  ctx.lineWidth = 5;
  // Medians: each vertex to opposite side's midpoint.
  strokeLine(ctx, t.a.x, t.a.y, t.midBC.x, t.midBC.y, 5, CENTROID_YELLOW);
  strokeLine(ctx, t.b.x, t.b.y, t.midCA.x, t.midCA.y, 5, CENTROID_YELLOW);
  strokeLine(ctx, t.c.x, t.c.y, t.midAB.x, t.midAB.y, 5, CENTROID_YELLOW);
  // Centroid marker.
  ctx.fillStyle = CENTROID_YELLOW;
  ctx.beginPath();
  ctx.arc(t.centroid.x, t.centroid.y, 7.5, 0, Math.PI * 2);
  ctx.fill();
}

function drawPerpendicularBisectors(ctx: CanvasRenderingContext2D, t: DerivedTriangle): void {
  // Circumcenter marker.
  ctx.fillStyle = BISECTOR_MAGENTA;
  ctx.beginPath();
  ctx.arc(t.circumcenter.x, t.circumcenter.y, 7.5, 0, Math.PI * 2);
  ctx.fill();
  // Three perpendicular bisector segments.
  strokeLine(
    ctx,
    t.perpExtAB.x,
    t.perpExtAB.y,
    t.perpExtAB_mirror.x,
    t.perpExtAB_mirror.y,
    5,
    BISECTOR_MAGENTA,
  );
  strokeLine(
    ctx,
    t.perpExtBC.x,
    t.perpExtBC.y,
    t.perpExtBC_mirror.x,
    t.perpExtBC_mirror.y,
    5,
    BISECTOR_MAGENTA,
  );
  strokeLine(
    ctx,
    t.perpExtCA.x,
    t.perpExtCA.y,
    t.perpExtCA_mirror.x,
    t.perpExtCA_mirror.y,
    5,
    BISECTOR_MAGENTA,
  );
}

function drawCircumcircle(ctx: CanvasRenderingContext2D, t: DerivedTriangle): void {
  const radius = dist(t.circumcenter, t.a);
  if (!Number.isFinite(radius) || radius <= 0) return;
  ctx.strokeStyle = BISECTOR_MAGENTA;
  ctx.lineWidth = 8;
  ctx.beginPath();
  ctx.arc(t.circumcenter.x, t.circumcenter.y, radius, 0, Math.PI * 2);
  ctx.stroke();
}
