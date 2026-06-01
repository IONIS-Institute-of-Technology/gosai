/**
 * Canvas plumbing and drawing helpers.
 *
 * The compositor sets up a single 2D canvas sized to the window in CSS pixels
 * (multiplied by devicePixelRatio for backing-store crispness). All layer
 * drawing happens in *reference space* (1920x1080) -- callers transform the
 * context via {@link applyReferenceTransform} before drawing so we can keep
 * the legacy coordinates intact.
 */

import { computeCSSMatrix3d, type Point2D, type Quad } from '@gosai/sdk';
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
 * the projector is expected to be aligned with the table; if it is not,
 * `applyKeystoneTransform` adds an extra CSS perspective layer on top).
 */
export function applyReferenceTransform(ctx: CanvasRenderingContext2D): void {
  const sx = ctx.canvas.width / REF_WIDTH;
  const sy = ctx.canvas.height / REF_HEIGHT;
  ctx.setTransform(sx, 0, 0, sy, 0, 0);
}

/**
 * Apply a CSS `matrix3d` keystone correction so that the rectangular canvas
 * appears -- once projected -- as a perfect rectangle on the physical surface
 * even when the projector and/or camera is angled.
 *
 * The four destination corners must be expressed in *projector display
 * pixels* (i.e. in the same coordinate system as `window.innerWidth/Height`
 * for the fullscreen app-host window). They are typically the
 * `surface_quad_display` produced by the calibration wizard: the user-picked
 * pool corners in normalised camera coords, warped through the
 * camera->display homography.
 *
 * Canvas-local content is laid out in CSS pixels; the canvas backing store
 * (devicePixelRatio multiplied) is independent and unaffected. The transform
 * uses the canvas' current CSS box as the source rectangle.
 *
 * The canvas keeps its CSS size set to fill its container (`100% / 100%`) and
 * uses `position: absolute; inset: 0;`. We override the layout to use
 * explicit CSS pixels for the duration of the transform so the math is
 * consistent with the destination quad expressed in window pixels.
 */
export function applyKeystoneTransform(canvas: HTMLCanvasElement, destination: Quad): void {
  const parent = canvas.parentElement;
  const ref = parent ?? document.documentElement;
  const refRect = ref.getBoundingClientRect();
  const width = Math.max(1, Math.round(refRect.width));
  const height = Math.max(1, Math.round(refRect.height));

  // Pin the canvas to explicit CSS dimensions so the matrix3d math (which
  // assumes the source rectangle is exactly the element's box) is well-defined
  // and not affected by CSS percent-based sizing.
  canvas.style.position = 'absolute';
  canvas.style.left = '0';
  canvas.style.top = '0';
  canvas.style.right = 'auto';
  canvas.style.bottom = 'auto';
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  canvas.style.transformOrigin = '0 0';
  // Avoid blurring edges at the warped corners.
  canvas.style.backfaceVisibility = 'hidden';
  canvas.style.transform = computeCSSMatrix3d(width, height, destination);
}

/** Remove a previously applied keystone transform. Restores the canvas to its
 * default stretched layout. */
export function clearKeystoneTransform(canvas: HTMLCanvasElement): void {
  canvas.style.transform = '';
  canvas.style.transformOrigin = '';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.left = '';
  canvas.style.top = '';
  canvas.style.right = '';
  canvas.style.bottom = '';
}

/** Re-export the homography point type so layer modules can take quads via
 * the same shape coming out of the calibration loader. */
export type { Point2D, Quad };

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
