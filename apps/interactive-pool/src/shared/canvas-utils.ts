/**
 * Canvas plumbing and drawing helpers.
 *
 * The compositor sets up a single 2D canvas sized to the window in CSS pixels
 * (multiplied by devicePixelRatio for backing-store crispness). All layer
 * drawing happens in *reference space* (1920x1080) -- callers transform the
 * context via {@link applyReferenceTransform} before drawing so we can keep
 * the legacy coordinates intact.
 */

import { REF_HEIGHT, REF_WIDTH } from './types.js';

/** Style the document body so the app-host window has no scrollbars/margins. */
export function setBodyFullscreen(): void {
  document.body.style.margin = '0';
  document.body.style.padding = '0';
  document.body.style.overflow = 'hidden';
  document.body.style.background = '#000';
  document.body.style.color = '#fff';
  document.body.style.fontFamily =
    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
}

export interface CanvasBundle {
  container: HTMLDivElement;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
}

/** Create a fullscreen, DPR-aware Canvas2D for the compositor. */
export function createCompositorCanvas(): CanvasBundle {
  setBodyFullscreen();
  const container = document.createElement('div');
  container.style.cssText = 'position:fixed;inset:0;background:#000;overflow:hidden;';
  document.body.appendChild(container);

  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;';
  container.appendChild(canvas);

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('interactive-pool: 2D canvas context unavailable');
  }

  return { container, canvas, ctx };
}

/**
 * Resize the canvas backing store to match its CSS box * DPR. Returns true
 * when the size actually changed (caller may want to re-render even outside
 * the rAF loop).
 */
export function fitCanvas(canvas: HTMLCanvasElement): boolean {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width * dpr));
  const h = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    return true;
  }
  return false;
}

/**
 * Apply a transform so subsequent drawing happens in 1920x1080 reference
 * coords. Stretches to fill the canvas (does not preserve aspect ratio --
 * the projector is expected to be aligned with the table).
 */
export function applyReferenceTransform(ctx: CanvasRenderingContext2D): void {
  const sx = ctx.canvas.width / REF_WIDTH;
  const sy = ctx.canvas.height / REF_HEIGHT;
  ctx.setTransform(sx, 0, 0, sy, 0, 0);
}

/**
 * Convenience: stroked circle outline (legacy p5 `circle` with no fill).
 */
export function strokeCircle(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  diameter: number,
  weight: number,
  color: string,
): void {
  ctx.lineWidth = weight;
  ctx.strokeStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, diameter / 2, 0, Math.PI * 2);
  ctx.stroke();
}

/** Filled circle. */
export function fillCircle(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  diameter: number,
  color: string,
): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, diameter / 2, 0, Math.PI * 2);
  ctx.fill();
}

/** Stroked straight line. */
export function strokeLine(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  weight: number,
  color: string,
): void {
  ctx.lineWidth = weight;
  ctx.strokeStyle = color;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

/**
 * Draw an axis-aligned ellipse with arbitrary width and height (legacy p5
 * `ellipse(x, y, w, h)` semantics: `w` and `h` are diameters, `x`/`y` is
 * the center).
 */
export function fillEllipse(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  color: string,
): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.ellipse(x, y, width / 2, height / 2, 0, 0, Math.PI * 2);
  ctx.fill();
}

/**
 * Draw text rotated 180 degrees so the legacy projector orientation (camera
 * inverted relative to the audience) reads correctly. Anchors the *center*
 * of the text at (x, y).
 */
export function drawRotatedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  fontPx: number,
  color: string,
  align: CanvasTextAlign = 'center',
  baseline: CanvasTextBaseline = 'middle',
): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(Math.PI);
  ctx.fillStyle = color;
  ctx.font = `${fontPx}px ui-monospace, monospace`;
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
  ctx.fillText(text, 0, 0);
  ctx.restore();
}

/** Plain (non-rotated) text helper. */
export function drawText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  fontPx: number,
  color: string,
  align: CanvasTextAlign = 'left',
  baseline: CanvasTextBaseline = 'alphabetic',
): void {
  ctx.fillStyle = color;
  ctx.font = `${fontPx}px ui-monospace, monospace`;
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
  ctx.fillText(text, x, y);
}

/** Stroked or filled rectangle in reference-space coords. */
export function strokeRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  weight: number,
  color: string,
): void {
  ctx.lineWidth = weight;
  ctx.strokeStyle = color;
  ctx.strokeRect(x, y, w, h);
}

export function fillRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string,
): void {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
}
