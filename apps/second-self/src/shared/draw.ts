/**
 * Canvas2D drawing primitives in reference-space coordinates. The compositor
 * sets the reference transform before layers render.
 */

import type { Rect } from './ui.js';

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

/**
 * Draws a `sw` x `sh` source as large as fits in a `maxW` x `maxH` box centred
 * on (`cx`, `cy`), keeping its aspect ratio. Returns where it landed, or null
 * when the source has no size yet.
 */
export function drawContain(
  ctx: CanvasRenderingContext2D,
  src: CanvasImageSource,
  sw: number,
  sh: number,
  cx: number,
  cy: number,
  maxW: number,
  maxH: number,
): Rect | null {
  if (sw <= 0 || sh <= 0) return null;
  const scale = Math.min(maxW / sw, maxH / sh);
  const w = sw * scale;
  const h = sh * scale;
  const x = cx - w / 2;
  const y = cy - h / 2;
  ctx.drawImage(src, x, y, w, h);
  return { x, y, w, h };
}
