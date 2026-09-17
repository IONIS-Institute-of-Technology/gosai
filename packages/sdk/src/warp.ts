/**
 * Warps an element onto an arbitrary quadrilateral with a CSS `matrix3d`
 * transform. Projection apps use it to land a canvas on a physical surface
 * seen at an angle, with the quad coming from calibration.
 */

import { computeCSSMatrix3d, type Quad } from './homography.js';

const WARP_PROPERTIES = [
  'position',
  'left',
  'top',
  'right',
  'bottom',
  'width',
  'height',
  'transform',
  'transformOrigin',
  'backfaceVisibility',
] as const;

type WarpProperty = (typeof WARP_PROPERTIES)[number];

/** The parts of an element the warp touches. */
export interface WarpTarget {
  readonly style: Pick<CSSStyleDeclaration, WarpProperty>;
  readonly parentElement: { readonly clientWidth: number; readonly clientHeight: number } | null;
}

export interface QuadWarpOptions {
  /**
   * Size of the element's own box, in CSS pixels, before the warp. Defaults
   * to its parent's client size, or the window size without a parent.
   */
  readonly width?: number;
  readonly height?: number;
}

const saved = new WeakMap<WarpTarget, Record<WarpProperty, string>>();

/**
 * Pins `el` to the top-left of its containing block at an explicit size and
 * maps its corners onto `quad`, given as `[topLeft, topRight, bottomRight,
 * bottomLeft]` in the containing block's CSS pixels. Throws when the quad is
 * degenerate. Calling it again replaces the previous warp.
 */
export function applyQuadWarp(el: WarpTarget, quad: Quad, options: QuadWarpOptions = {}): void {
  const width = Math.max(1, Math.round(options.width ?? containerWidth(el)));
  const height = Math.max(1, Math.round(options.height ?? containerHeight(el)));
  // Compute first so a degenerate quad leaves the element untouched.
  const transform = computeCSSMatrix3d(width, height, quad);

  if (!saved.has(el)) {
    const previous = {} as Record<WarpProperty, string>;
    for (const property of WARP_PROPERTIES) previous[property] = el.style[property];
    saved.set(el, previous);
  }

  el.style.position = 'absolute';
  el.style.left = '0';
  el.style.top = '0';
  el.style.right = 'auto';
  el.style.bottom = 'auto';
  el.style.width = `${width}px`;
  el.style.height = `${height}px`;
  el.style.transformOrigin = '0 0';
  el.style.backfaceVisibility = 'hidden';
  el.style.transform = transform;
}

/** Removes a warp and restores the inline styles `el` had before it. */
export function clearQuadWarp(el: WarpTarget): void {
  const previous = saved.get(el);
  if (!previous) return;
  saved.delete(el);
  for (const property of WARP_PROPERTIES) el.style[property] = previous[property];
}

function containerWidth(el: WarpTarget): number {
  return el.parentElement?.clientWidth ?? window.innerWidth;
}

function containerHeight(el: WarpTarget): number {
  return el.parentElement?.clientHeight ?? window.innerHeight;
}
