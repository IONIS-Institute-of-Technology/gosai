/**
 * Affine function visualizer.
 *
 * Renders a coordinate grid centred on the table and draws the affine
 * function `y = ax + b` passing through pairs of detected balls. Up to two
 * independent lines are drawn (balls 0-1 -> blue line, balls 2-3 -> green
 * line) matching the legacy app.
 *
 * Coordinate handling: everything is drawn in a 180-degree-rotated frame
 * (translate to bottom-right corner, rotate PI) so it reads correctly from
 * the projector's viewing direction. Ball positions are mirrored about the
 * grid centre so they still line up with their physical positions on the
 * table when the rotation is applied.
 */

import { REF_HEIGHT, REF_WIDTH, type FrameContext, type Layer } from '../shared/types.js';
import { fillCircle, strokeLine } from '../shared/canvas-utils.js';
import type { PoolFeed } from '../shared/feed.js';

const GRID_COLS = 22;
const GRID_ROWS = 12;
const CASE_W = REF_WIDTH / GRID_COLS; // ~87.3 px
const CASE_H = REF_HEIGHT / GRID_ROWS; // 90 px
const ORIGIN_X = REF_WIDTH / 2; // 960
const ORIGIN_Y = REF_HEIGHT / 2; // 540

const GRID_COLOR = '#c8c8c8';
const LINE_COLORS = ['#009dff', '#38ff15'];

export function createAffineLayer(feed: PoolFeed): Layer {
  return {
    render(frame: FrameContext): void {
      const { ctx } = frame;
      ctx.save();
      ctx.translate(REF_WIDTH, REF_HEIGHT);
      ctx.rotate(Math.PI);

      drawGrid(ctx);

      const balls = feed.balls.balls;
      // Mirror ball positions about the grid centre so they show up at their
      // physical pool-table positions once the global rotation is applied.
      const mirrored = balls.map((b) => ({
        x: -(b.x - ORIGIN_X) + ORIGIN_X,
        y: -(b.y - ORIGIN_Y) + ORIGIN_Y,
      }));

      // Up to two lines: from pairs (0, 1) and (2, 3).
      for (let i = 0; i < 2; i++) {
        const a = mirrored[i * 2];
        const b = mirrored[i * 2 + 1];
        if (!a || !b) continue;
        drawAffineLine(ctx, a, b, LINE_COLORS[i] ?? '#ffffff');
      }

      // Draw mirrored balls so the white outlines from the balls layer line
      // up with the affine geometry (the always-on balls layer draws in
      // un-rotated space; here we add a faint inner dot for visual clarity).
      for (const mp of mirrored) {
        fillCircle(ctx, mp.x, mp.y, 16, '#ffffff');
      }

      ctx.restore();
    },
  };
}

// ---------------------------------------------------------------------------
// Grid + axes
// ---------------------------------------------------------------------------

function drawGrid(ctx: CanvasRenderingContext2D): void {
  ctx.strokeStyle = GRID_COLOR;
  ctx.lineWidth = 5;

  // Axes.
  strokeLine(ctx, 0, ORIGIN_Y, REF_WIDTH - 70, ORIGIN_Y, 5, GRID_COLOR);
  strokeLine(ctx, ORIGIN_X, 70, ORIGIN_X, REF_HEIGHT, 5, GRID_COLOR);

  // Origin dot.
  fillCircle(ctx, ORIGIN_X, ORIGIN_Y, 20, GRID_COLOR);

  // Top arrow (y-axis).
  strokeLine(ctx, ORIGIN_X - CASE_W / 2, 70 + CASE_H / 2, ORIGIN_X, 70, 5, GRID_COLOR);
  strokeLine(ctx, ORIGIN_X + CASE_W / 2, 70 + CASE_H / 2, ORIGIN_X, 70, 5, GRID_COLOR);

  // Right arrow (x-axis).
  strokeLine(
    ctx,
    REF_WIDTH - 70 - CASE_W / 2,
    ORIGIN_Y - CASE_H / 2,
    REF_WIDTH - 70,
    ORIGIN_Y,
    5,
    GRID_COLOR,
  );
  strokeLine(
    ctx,
    REF_WIDTH - 70 - CASE_W / 2,
    ORIGIN_Y + CASE_H / 2,
    REF_WIDTH - 70,
    ORIGIN_Y,
    5,
    GRID_COLOR,
  );

  // Axis labels.
  ctx.fillStyle = GRID_COLOR;
  ctx.font = '40px ui-monospace, monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('O', ORIGIN_X - 35, ORIGIN_Y + 35);
  ctx.fillText('x', REF_WIDTH - 30 - 70, ORIGIN_Y + 65);
  ctx.fillText('y', ORIGIN_X + 55, 45 + 70);

  // Graduations on x-axis.
  for (let x = 0; x < REF_WIDTH + 1 - 2 * CASE_W; x += CASE_W) {
    strokeLine(ctx, x, ORIGIN_Y - 20, x, ORIGIN_Y + 20, 5, GRID_COLOR);
  }
  // Graduations on y-axis.
  for (let y = 2 * CASE_H; y < REF_HEIGHT + 1; y += CASE_H) {
    strokeLine(ctx, ORIGIN_X - 20, y, ORIGIN_X + 20, y, 5, GRID_COLOR);
  }

  // Number labels along x-axis (skipping 0).
  let i = -1;
  for (let x = ORIGIN_X - CASE_W - 10; x < REF_WIDTH - 2 * CASE_W; x += CASE_W) {
    if (i !== 0) ctx.fillText(String(i), x, ORIGIN_Y + 60);
    i += 1;
  }
  // Number labels along y-axis (skipping 0).
  let j = -1;
  for (let y = ORIGIN_Y + CASE_H + 10; y > CASE_H * 2; y -= CASE_H) {
    if (j !== 0) ctx.fillText(String(j), ORIGIN_X - 60, y);
    j += 1;
  }
}

// ---------------------------------------------------------------------------
// Affine line + equation
// ---------------------------------------------------------------------------

interface Pt {
  x: number;
  y: number;
}

function screenToGridX(x: number): number {
  return x * (GRID_COLS / REF_WIDTH) - GRID_COLS / 2;
}
function screenToGridY(y: number): number {
  return -1 * (y * (GRID_ROWS / REF_HEIGHT) - GRID_ROWS / 2);
}
function gridToScreenX(x: number): number {
  return (REF_WIDTH * (x + GRID_COLS / 2)) / GRID_COLS;
}
function gridToScreenY(y: number): number {
  return -1 * REF_HEIGHT * ((y + GRID_ROWS / 2) / GRID_ROWS) + REF_HEIGHT;
}

function drawAffineLine(ctx: CanvasRenderingContext2D, a: Pt, b: Pt, color: string): void {
  if (a.x === b.x) return;
  const gAx = screenToGridX(a.x);
  const gAy = screenToGridY(a.y);
  const gBx = screenToGridX(b.x);
  const gBy = screenToGridY(b.y);
  const slope = (gBy - gAy) / (gBx - gAx);
  if (!Number.isFinite(slope)) return;
  const intercept = gAy - slope * gAx;

  // Compute the line's intersection with the grid edges, clipping to the
  // [-cols/2, +cols/2] x [-rows/2, +rows/2] bounding box.
  let xL = -GRID_COLS / 2;
  let yL = slope * xL + intercept;
  let xR = GRID_COLS / 2;
  let yR = slope * xR + intercept;

  if (yL < -GRID_ROWS / 2) {
    yL = -GRID_ROWS / 2;
    xL = (yL - intercept) / slope;
  }
  if (yL > GRID_ROWS / 2) {
    yL = GRID_ROWS / 2;
    xL = (yL - intercept) / slope;
  }
  if (yR < -GRID_ROWS / 2) {
    yR = -GRID_ROWS / 2;
    xR = (yR - intercept) / slope;
  }
  if (yR > GRID_ROWS / 2) {
    yR = GRID_ROWS / 2;
    xR = (yR - intercept) / slope;
  }

  const screenL = { x: gridToScreenX(xL), y: gridToScreenY(yL) };
  const screenR = { x: gridToScreenX(xR), y: gridToScreenY(yR) };
  strokeLine(ctx, screenL.x, screenL.y, screenR.x, screenR.y, 4, color);

  drawEquation(ctx, slope, intercept, screenR, color);
}

function drawEquation(
  ctx: CanvasRenderingContext2D,
  slope: number,
  intercept: number,
  screenR: Pt,
  color: string,
): void {
  const aRoundedNum = Math.round(slope * 10) / 10;
  const bRoundedNum = Math.round(intercept * 10) / 10;

  let bStr: string;
  if (bRoundedNum === 0) {
    bStr = aRoundedNum !== 0 ? '' : '0';
  } else if (bRoundedNum > 0) {
    bStr = aRoundedNum !== 0 ? `+ ${bRoundedNum}` : `${bRoundedNum}`;
  } else {
    bStr = `${bRoundedNum}`;
  }

  let aStr: string;
  if (aRoundedNum === 0) aStr = '';
  else if (aRoundedNum === 1) aStr = 'x';
  else if (aRoundedNum === -1) aStr = '-x';
  else aStr = `${aRoundedNum}x`;

  // Anchor the text near the right end of the line, biased away from it
  // depending on the slope direction (legacy behaviour).
  let xGrid = screenToGridX(screenR.x - 300);
  let yGrid = slope * xGrid + intercept;
  if (slope > 0) yGrid -= 0.5;
  else yGrid += 0.5;
  const x = gridToScreenX(xGrid);
  const y = gridToScreenY(yGrid);

  ctx.fillStyle = color;
  ctx.font = '40px ui-monospace, monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(`y = ${aStr} ${bStr}`.replace(/\s+/g, ' ').trim(), x, y);
}
