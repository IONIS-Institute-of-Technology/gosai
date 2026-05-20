/**
 * Rendering helpers for experiences. Phase 4 ships a fullscreen `<canvas>`
 * helper; Phase 5/6 will add typed binding utilities for camera frames and ML
 * overlays.
 */

export interface CanvasOptions {
  readonly id?: string;
  readonly className?: string;
  readonly background?: string;
  readonly devicePixelRatio?: number;
}

export function createCanvas(parent: HTMLElement, options: CanvasOptions = {}): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  if (options.id) canvas.id = options.id;
  if (options.className) canvas.className = options.className;
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.display = 'block';
  if (options.background) canvas.style.background = options.background;
  parent.appendChild(canvas);
  fitCanvas(canvas, options.devicePixelRatio);
  return canvas;
}

export function fitCanvas(canvas: HTMLCanvasElement, dpr = window.devicePixelRatio || 1): void {
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.floor(rect.width * dpr));
  canvas.height = Math.max(1, Math.floor(rect.height * dpr));
}

export function fullscreenContainer(): HTMLElement {
  const el = document.createElement('div');
  el.style.position = 'fixed';
  el.style.inset = '0';
  el.style.display = 'block';
  el.style.background = 'black';
  el.style.overflow = 'hidden';
  document.body.appendChild(el);
  return el;
}
