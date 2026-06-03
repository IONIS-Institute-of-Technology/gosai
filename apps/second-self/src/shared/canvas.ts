/**
 * Canvas plumbing and Canvas2D drawing helpers.
 *
 * The compositor owns a single fullscreen canvas sized to the window in CSS
 * pixels (multiplied by devicePixelRatio for crispness). Layers draw in the
 * portrait reference space (1080x1920); the compositor applies
 * {@link applyReferenceTransform} before each frame so layers use absolute
 * mirror-space coordinates.
 */

import { REF_HEIGHT, REF_WIDTH } from './types.js';

export function setBodyFullscreen(): void {
  document.body.style.margin = '0';
  document.body.style.padding = '0';
  document.body.style.overflow = 'hidden';
  document.body.style.background = '#000';
  document.body.style.color = '#fff';
  document.body.style.fontFamily = 'ui-sans-serif, system-ui, sans-serif';
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
  if (!ctx) throw new Error('second-self: 2D canvas context unavailable');

  return { container, canvas, ctx };
}

/** Resize the backing store to the CSS box * DPR. Returns true when changed. */
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

/** How the reference space is mapped onto the physical canvas. */
export type DisplayFit = 'contain' | 'cover' | 'stretch';

/**
 * Transform the context so subsequent drawing happens in reference coordinates,
 * adapting the logical design space to any physical screen size/orientation:
 *
 * - `contain` (default): preserve aspect, letterbox. Never distorts; black bars
 *   on screens whose aspect differs from the reference (e.g. a portrait design
 *   on a landscape monitor).
 * - `cover`: preserve aspect, fill the screen and crop the overflow.
 * - `stretch`: fill exactly, distorting aspect (legacy behavior; rarely wanted).
 *
 * Returns the applied scale/offset so callers can map screen<->reference coords.
 */
export function applyReferenceTransform(
  ctx: CanvasRenderingContext2D,
  fit: DisplayFit = 'contain',
  refWidth: number = REF_WIDTH,
  refHeight: number = REF_HEIGHT,
): { scaleX: number; scaleY: number; offsetX: number; offsetY: number } {
  const cw = ctx.canvas.width;
  const ch = ctx.canvas.height;
  let scaleX: number;
  let scaleY: number;
  if (fit === 'stretch') {
    scaleX = cw / refWidth;
    scaleY = ch / refHeight;
  } else {
    const ratio =
      fit === 'cover'
        ? Math.max(cw / refWidth, ch / refHeight)
        : Math.min(cw / refWidth, ch / refHeight);
    scaleX = ratio;
    scaleY = ratio;
  }
  const offsetX = (cw - refWidth * scaleX) / 2;
  const offsetY = (ch - refHeight * scaleY) / 2;
  ctx.setTransform(scaleX, 0, 0, scaleY, offsetX, offsetY);
  return { scaleX, scaleY, offsetX, offsetY };
}

// ---------------------------------------------------------------------------
// Drawing primitives (reference-space coordinates).
// ---------------------------------------------------------------------------

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

export function drawText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  fontPx: number,
  color: string,
  align: CanvasTextAlign = 'left',
  baseline: CanvasTextBaseline = 'alphabetic',
  font = 'ui-sans-serif, system-ui, sans-serif',
): void {
  ctx.fillStyle = color;
  ctx.font = `${fontPx}px ${font}`;
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
  ctx.fillText(text, x, y);
}
