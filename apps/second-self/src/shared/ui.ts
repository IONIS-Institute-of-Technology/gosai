/**
 * Gesture UI shared by the menu, the calibration wizard and the games: the
 * fingertip cursor, dwell ("hover to press") buttons, progress rings and small
 * geometry helpers.
 */

import type { FitTransform, Size } from '@gosai/sdk';
import { drawText } from './draw.js';
import { isValid } from './mirror.js';
import type { Landmark, MirroredData, Viewport } from './types.js';

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * The CSS-pixel rectangle a reference space covers, from the transform
 * `FullscreenCanvas.fit()` returned (in backing-store pixels) and the CSS
 * pixels per backing-store pixel.
 */
export function cssViewport(fit: FitTransform, reference: Size, cssPerPixel: number): Viewport {
  return {
    x: fit.offsetX * cssPerPixel,
    y: fit.offsetY * cssPerPixel,
    width: reference.width * fit.scaleX * cssPerPixel,
    height: reference.height * fit.scaleY * cssPerPixel,
  };
}

export function dist(x1: number, y1: number, x2: number, y2: number): number {
  return Math.hypot(x1 - x2, y1 - y2);
}

/** True when `point` lies inside `rect` grown by `pad` on every side. */
export function inRect(point: Point | null, rect: Rect, pad = 0): boolean {
  return (
    point !== null &&
    point.x > rect.x - pad &&
    point.x < rect.x + rect.w + pad &&
    point.y > rect.y - pad &&
    point.y < rect.y + rect.h + pad
  );
}

/**
 * Dwell time after one frame. It grows while hovered and decays `decay` times
 * faster otherwise, so a single dropped tracking frame doesn't reset it.
 */
export function stepDwell(ms: number, hovered: boolean, deltaMs: number, decay = 2): number {
  return hovered ? ms + deltaMs : Math.max(0, ms - deltaMs * decay);
}

/** Starts a new path holding a rounded rectangle. The radius is clamped to fit. */
export function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, Math.max(0, Math.min(r, w / 2, h / 2)));
}

export interface ProgressRingStyle {
  readonly color: string;
  /** Stroke width of the arc. Ignored for a filled pie. */
  readonly lineWidth?: number;
  /** Fill a pie slice instead of stroking an arc. */
  readonly fill?: boolean;
}

/** Draws `progress` (0 to 1) of a circle clockwise from twelve o'clock. */
export function drawProgressRing(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  progress: number,
  style: ProgressRingStyle,
): void {
  const p = Math.min(1, progress);
  if (!(p > 0)) return;
  const start = -Math.PI / 2;
  const end = start + p * Math.PI * 2;
  ctx.beginPath();
  if (style.fill) {
    ctx.moveTo(x, y);
    ctx.arc(x, y, radius, start, end);
    ctx.closePath();
    ctx.fillStyle = style.color;
    ctx.fill();
  } else {
    ctx.arc(x, y, radius, start, end);
    ctx.strokeStyle = style.color;
    ctx.lineWidth = style.lineWidth ?? 5;
    ctx.stroke();
  }
}

export interface HoverButtonStyle {
  /** Outline color, also used for the progress fill. */
  readonly color: string;
  /** Progress fill. Defaults to `color` at 35% opacity. */
  readonly progressColor?: string;
  readonly textColor?: string;
  readonly lineWidth?: number;
  readonly radius?: number;
  readonly fontPx?: number;
  readonly align?: 'left' | 'center';
}

/** A dwell button: rounded box, a fill that grows with `progress`, and a label. */
export function drawHoverButton(
  ctx: CanvasRenderingContext2D,
  rect: Rect,
  label: string,
  progress: number,
  style: HoverButtonStyle,
): void {
  const radius = style.radius ?? 16;
  ctx.fillStyle = 'rgba(0,0,0,0.65)';
  ctx.strokeStyle = style.color;
  ctx.lineWidth = style.lineWidth ?? 3;
  roundRect(ctx, rect.x, rect.y, rect.w, rect.h, radius);
  ctx.fill();
  ctx.stroke();

  const p = Math.min(1, progress);
  if (p > 0) {
    ctx.save();
    if (!style.progressColor) ctx.globalAlpha *= 0.35;
    ctx.fillStyle = style.progressColor ?? style.color;
    roundRect(ctx, rect.x, rect.y, rect.w * p, rect.h, radius);
    ctx.fill();
    ctx.restore();
  }

  const centered = (style.align ?? 'center') === 'center';
  drawText(
    ctx,
    label,
    centered ? rect.x + rect.w / 2 : rect.x + 28,
    rect.y + rect.h / 2,
    style.fontPx ?? 40,
    style.textColor ?? '#ffffff',
    centered ? 'center' : 'left',
    'middle',
  );
}

export interface CursorPickerOptions {
  /** How long the last position survives a tracking dropout. */
  readonly graceMs?: number;
  /** How much higher the other hand must be before it takes the cursor. */
  readonly switchMarginPx?: number;
  /** How long the other hand must stay higher before it takes the cursor. */
  readonly switchMs?: number;
  /** Fall back to the body pose index fingertips when no hand is tracked. */
  readonly bodyFallback?: boolean;
}

/** MediaPipe landmark indices of the index fingertip. */
const HAND_INDEX_TIP = 8;
const BODY_RIGHT_INDEX = 20;
const BODY_LEFT_INDEX = 19;

/**
 * An index-fingertip cursor over the mirrored feed. The hand holding the
 * cursor keeps it while tracked; the other hand takes over only when it stays
 * clearly higher for a while, or when the active hand is lost. After a full
 * loss the last position survives a short grace period, so tracking flicker
 * doesn't reset dwell timers.
 */
export class CursorPicker {
  private readonly graceMs: number;
  private readonly switchMarginPx: number;
  private readonly switchMs: number;
  private readonly bodyFallback: boolean;
  private activeHand: 'right' | 'left' | null = null;
  private otherHigherSince = 0;
  private last: Point | null = null;
  private lastTs = 0;

  constructor(options: CursorPickerOptions = {}) {
    this.graceMs = options.graceMs ?? 300;
    this.switchMarginPx = options.switchMarginPx ?? 80;
    this.switchMs = options.switchMs ?? 400;
    this.bodyFallback = options.bodyFallback ?? false;
  }

  reset(): void {
    this.activeHand = null;
    this.otherHigherSince = 0;
    this.last = null;
    this.lastTs = 0;
  }

  pick(mirror: MirroredData, now: number): Point | null {
    const right = mirror.right_hand_pose[HAND_INDEX_TIP];
    const left = mirror.left_hand_pose[HAND_INDEX_TIP];
    const hand = this.pickHand(right, left, now);
    let tip: Landmark | undefined = hand === 'right' ? right : hand === 'left' ? left : undefined;
    if (!tip && this.bodyFallback) {
      tip = [mirror.body_pose[BODY_RIGHT_INDEX], mirror.body_pose[BODY_LEFT_INDEX]].find(isValid);
    }
    if (tip) {
      this.last = { x: tip[0]!, y: tip[1]! };
      this.lastTs = now;
      return this.last;
    }
    if (this.last && now - this.lastTs < this.graceMs) return this.last;
    this.last = null;
    return null;
  }

  private pickHand(
    right: Landmark | undefined,
    left: Landmark | undefined,
    now: number,
  ): 'right' | 'left' | null {
    const rightValid = isValid(right);
    const leftValid = isValid(left);
    if (this.activeHand && !(this.activeHand === 'right' ? rightValid : leftValid)) {
      this.activeHand = null;
    }
    if (!this.activeHand) {
      this.otherHigherSince = 0;
      if (rightValid && leftValid) this.activeHand = right[1]! <= left[1]! ? 'right' : 'left';
      else if (rightValid) this.activeHand = 'right';
      else if (leftValid) this.activeHand = 'left';
      return this.activeHand;
    }
    if (!rightValid || !leftValid) {
      this.otherHigherSince = 0;
      return this.activeHand;
    }
    const active = this.activeHand === 'right' ? right : left;
    const other = this.activeHand === 'right' ? left : right;
    if (other[1]! < active[1]! - this.switchMarginPx) {
      if (this.otherHigherSince === 0) this.otherHigherSince = now;
      if (now - this.otherHigherSince >= this.switchMs) {
        this.activeHand = this.activeHand === 'right' ? 'left' : 'right';
        this.otherHigherSince = 0;
      }
    } else {
      this.otherHigherSince = 0;
    }
    return this.activeHand;
  }
}
