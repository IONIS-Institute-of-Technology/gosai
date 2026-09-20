/**
 * What the wizard draws on the mirror.
 *
 * The mirror is a display with no keyboard and no mouse, so nothing here is a
 * control: it is the target to aim at, the camera preview, the instructions
 * and the numbers, read at arm's length by someone holding a sheet of paper.
 * Large type, high contrast, one idea per line, and nothing drawn over the
 * middle of a target the operator is aiming at.
 *
 * Everything comes from the same {@link WizardStatus} the control window
 * draws, plus the two things only the canvas has: where the mark goes and the
 * live camera frame.
 */

import type { StatusReading, StatusTone, WizardStatus } from '../channel.js';
import { drawText, fillCircle, strokeCircle, strokeLine } from '../../shared/draw.js';
import { REF_HEIGHT, REF_WIDTH } from '../../shared/types.js';
import { drawProgressRing, roundRect, type Point, type Rect } from '../../shared/ui.js';

export const WHITE = '#ffffff';
export const DIM = 'rgba(255,255,255,0.65)';
export const ORANGE = '#ff8100';
export const GREEN = '#a6d854';
export const RED = '#ff6b6b';

/** A decoded camera frame, kept by the wizard while the lens is being captured. */
export interface CameraFrame {
  readonly image: CanvasImageSource;
  readonly width: number;
  readonly height: number;
}

/** The live camera, while the lens is being calibrated. */
export interface CameraView {
  readonly frame: CameraFrame | null;
  readonly hull: readonly (readonly number[])[];
  readonly detected: boolean;
  /** 0 to 1 of a flash that fades after a view was accepted. */
  readonly flash: number;
}

export interface MirrorView {
  readonly status: WizardStatus;
  /** The mark being aimed at, when the round has planned one. */
  readonly target: Point | null;
  readonly camera: CameraView | null;
}

/** Margin kept on both sides, so nothing runs off the edge of the mirror. */
const SIDE_MARGIN = 40;
/** Small enough to still be read across a room. */
const MIN_FONT_PX = 22;

const FOOTER = 'Every button and key is in the control window';

/** The whole screen for one frame. */
export function renderScreen(ctx: CanvasRenderingContext2D, view: MirrorView): void {
  const { status } = view;
  if (status.phase === 'lens-capture') renderLensCapture(ctx, status, view.camera);
  else if (status.phase === 'align' && view.target) renderAlign(ctx, status, view.target);
  else renderBlockScreen(ctx, status);
  if (status.countdown !== null) drawCountdown(ctx, status.countdown, view.target);
  drawFooter(ctx, FOOTER);
  drawMessage(ctx, status.message);
}

/**
 * One centered line, shrunk when it would not fit across the canvas. Numbers
 * coming back from a fit are not known in advance, so a line that grows has to
 * get smaller rather than run off the mirror.
 */
export function drawFitted(
  ctx: CanvasRenderingContext2D,
  text: string,
  y: number,
  size: number,
  color: string,
): void {
  ctx.font = `${size}px ui-sans-serif, system-ui, sans-serif`;
  const max = REF_WIDTH - 2 * SIDE_MARGIN;
  const width = ctx.measureText(text).width;
  const fitted = width > max ? Math.max(MIN_FONT_PX, Math.floor((size * max) / width)) : size;
  drawText(ctx, text, REF_WIDTH / 2, y, fitted, color, 'center', 'middle');
}

/** A block of lines, the first one as a heading. Returns the y below the block. */
export function drawBlock(
  ctx: CanvasRenderingContext2D,
  lines: readonly string[],
  topY: number,
  options: { readonly heading?: boolean; readonly color?: string; readonly size?: number } = {},
): number {
  const heading = options.heading ?? true;
  const body = options.size ?? 36;
  let y = topY;
  for (const [index, line] of lines.entries()) {
    const size = heading && index === 0 ? 54 : body;
    if (line) {
      drawFitted(ctx, line, y, size, heading && index === 0 ? WHITE : (options.color ?? DIM));
    }
    y += size + 18;
  }
  return y;
}

/** The line along the bottom that says where the controls are. */
function drawFooter(ctx: CanvasRenderingContext2D, text: string): void {
  drawFitted(ctx, text, REF_HEIGHT - 70, 28, DIM);
}

function drawMessage(ctx: CanvasRenderingContext2D, message: string): void {
  if (!message) return;
  drawFitted(ctx, message, REF_HEIGHT - 130, 32, ORANGE);
}

/** How many chips fit across the mirror before they have to be shrunk. */
const CHIPS_PER_ROW = 3;
/** Vertical step between two rows of chips. */
const CHIP_ROW_PX = 64;

/** The readings as chips, wrapped into rows so none runs off the mirror. */
function drawReadings(
  ctx: CanvasRenderingContext2D,
  readings: readonly StatusReading[],
  y: number,
): void {
  for (let start = 0, row = 0; start < readings.length; start += CHIPS_PER_ROW, row++) {
    drawChipRow(ctx, readings.slice(start, start + CHIPS_PER_ROW), y + row * CHIP_ROW_PX);
  }
}

function drawChipRow(
  ctx: CanvasRenderingContext2D,
  readings: readonly StatusReading[],
  y: number,
): void {
  if (readings.length === 0) return;
  const labels = readings.map((reading) => `${reading.label} ${reading.value}`);
  const gap = 18;
  let size = 28;
  let widths: number[] = [];
  for (;;) {
    ctx.font = `${size}px ui-sans-serif, system-ui, sans-serif`;
    widths = labels.map((label) => ctx.measureText(label).width + 1.6 * size);
    const total = sum(widths) + gap * (labels.length - 1);
    if (total <= REF_WIDTH - 2 * SIDE_MARGIN || size <= MIN_FONT_PX) break;
    size -= 2;
  }
  let x = (REF_WIDTH - (sum(widths) + gap * (labels.length - 1))) / 2;
  for (const [index, reading] of readings.entries()) {
    const width = widths[index] ?? 0;
    const color = reading.ok ? GREEN : ORANGE;
    const height = size + 24;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    roundRect(ctx, x, y - height / 2, width, height, height / 2);
    ctx.fill();
    ctx.stroke();
    drawText(ctx, labels[index] ?? '', x + width / 2, y, size, color, 'center', 'middle');
    x += width + gap;
  }
}

function sum(values: readonly number[]): number {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

/**
 * The target itself: a thin ring and a fine cross, with the middle left empty
 * so the reflection of the printed corner can be seen inside it. Nothing
 * pulses here; a moving mark is a moving aim point.
 */
export function drawCrosshair(ctx: CanvasRenderingContext2D, point: Point): void {
  const { x, y } = point;
  strokeCircle(ctx, x, y, 96, 2, DIM);
  strokeCircle(ctx, x, y, 24, 3, ORANGE);
  for (const [dx, dy] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const) {
    strokeLine(ctx, x + dx * 18, y + dy * 18, x + dx * 64, y + dy * 64, 2, ORANGE);
  }
  fillCircle(ctx, x, y, 5, ORANGE);
}

function renderAlign(ctx: CanvasRenderingContext2D, status: WizardStatus, target: Point): void {
  drawCrosshair(ctx, target);
  // Keep the panel in the half of the canvas the target is not in, so nothing
  // is written next to the point being aimed at.
  const top = target.y > REF_HEIGHT / 2;
  const panelY = top ? 200 : REF_HEIGHT - 640;
  drawBlock(ctx, [status.title], panelY);
  drawBlock(ctx, status.lines, panelY + 110, { heading: false, size: 34 });
  drawReadings(ctx, status.readings, panelY + 130 + status.lines.length * 52);
  if (status.progress) drawFitted(ctx, status.progress.label, REF_HEIGHT - 180, 30, DIM);
}

/**
 * Everything that is a page of text: the measurements, the lens screens, the
 * fit, the check and the verify screen the skeleton is drawn under.
 */
function renderBlockScreen(ctx: CanvasRenderingContext2D, status: WizardStatus): void {
  if (status.form) backdrop(ctx);
  let y = drawBlock(ctx, [status.title], 280);
  const headline = status.headline;
  if (headline) {
    drawText(
      ctx,
      headline.text,
      REF_WIDTH / 2,
      y + 60,
      76,
      toneColor(headline.tone),
      'center',
      'middle',
    );
    y += 160;
  }
  y = drawBlock(ctx, status.lines, y + 40, { heading: false, size: 34 });
  if (status.progress) {
    drawFitted(ctx, status.progress.label, y + 20, 32, DIM);
    y += 70;
  }
  drawReadings(ctx, status.readings, y + 40);
  if (status.trim) {
    const trim = `trim ${signed(status.trim[0])}, ${signed(status.trim[1])} px`;
    drawFitted(ctx, trim, REF_HEIGHT - 260, 36, DIM);
  }
}

const PREVIEW: Rect = { x: 90, y: 560, w: 900, h: 700 };

function renderLensCapture(
  ctx: CanvasRenderingContext2D,
  status: WizardStatus,
  camera: CameraView | null,
): void {
  drawBlock(ctx, [status.title], 200);
  drawBlock(ctx, status.lines, 300, { heading: false, size: 36, color: WHITE });

  ctx.fillStyle = 'rgba(255,255,255,0.06)';
  ctx.fillRect(PREVIEW.x, PREVIEW.y, PREVIEW.w, PREVIEW.h);
  const frame = camera?.frame ?? null;
  if (frame) {
    // Mirrored, so moving the sheet left moves the picture left.
    const scale = Math.min(PREVIEW.w / frame.width, PREVIEW.h / frame.height);
    const width = frame.width * scale;
    const height = frame.height * scale;
    const x = PREVIEW.x + (PREVIEW.w - width) / 2;
    const y = PREVIEW.y + (PREVIEW.h - height) / 2;
    ctx.save();
    ctx.translate(x + width, y);
    ctx.scale(-1, 1);
    ctx.drawImage(frame.image, 0, 0, width, height);
    ctx.restore();
    drawHull(
      ctx,
      camera?.hull ?? [],
      frame,
      { x, y, w: width, h: height },
      camera?.detected ?? false,
    );
  } else {
    drawText(ctx, 'waiting for the camera…', REF_WIDTH / 2, 910, 32, DIM, 'center', 'middle');
  }
  const flash = camera?.flash ?? 0;
  if (flash > 0) {
    ctx.fillStyle = `rgba(166,216,84,${(0.45 * flash).toFixed(3)})`;
    ctx.fillRect(PREVIEW.x, PREVIEW.y, PREVIEW.w, PREVIEW.h);
  }

  const progress = status.progress;
  const ratio = progress && progress.total > 0 ? progress.done / progress.total : 0;
  drawProgressRing(ctx, REF_WIDTH / 2, 1480, 80, ratio, { color: GREEN, lineWidth: 12 });
  drawText(ctx, `${Math.round(ratio * 100)}%`, REF_WIDTH / 2, 1480, 36, WHITE, 'center', 'middle');
  if (progress) drawText(ctx, progress.label, REF_WIDTH / 2, 1620, 30, DIM, 'center', 'middle');
}

/** The detected board over the mirrored preview, in the same mirrored place. */
function drawHull(
  ctx: CanvasRenderingContext2D,
  hull: readonly (readonly number[])[],
  frame: CameraFrame,
  box: Rect,
  detected: boolean,
): void {
  if (hull.length < 3 || frame.width <= 0 || frame.height <= 0) return;
  ctx.beginPath();
  for (const [index, point] of hull.entries()) {
    const px = box.x + box.w - ((point[0] ?? 0) / frame.width) * box.w;
    const py = box.y + ((point[1] ?? 0) / frame.height) * box.h;
    if (index === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.strokeStyle = detected ? GREEN : ORANGE;
  ctx.lineWidth = 4;
  ctx.stroke();
}

/**
 * The seconds left of a timed capture, drawn big enough to read from where the
 * operator is standing with the sheet in both hands. It goes in the band
 * between the target and the panel, so a count never covers the mark being
 * aimed at.
 */
function drawCountdown(ctx: CanvasRenderingContext2D, seconds: number, target: Point | null): void {
  const y = !target ? REF_HEIGHT - 420 : target.y > REF_HEIGHT / 2 ? 700 : 1100;
  fillCircle(ctx, REF_WIDTH / 2, y, 130, 'rgba(0,0,0,0.65)');
  strokeCircle(ctx, REF_WIDTH / 2, y, 130, 4, ORANGE);
  drawText(ctx, String(seconds), REF_WIDTH / 2, y, 140, WHITE, 'center', 'middle');
}

/** A full-canvas backdrop, for the phases the operator is typing through. */
function backdrop(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = 'rgba(0,0,0,0.85)';
  ctx.fillRect(0, 0, REF_WIDTH, REF_HEIGHT);
}

/** One page of text on the mirror, for a screen with no status behind it. */
export function renderNotice(ctx: CanvasRenderingContext2D, lines: readonly string[]): void {
  backdrop(ctx);
  drawBlock(ctx, lines, 500);
}

export function toneColor(tone: StatusTone): string {
  if (tone === 'good') return GREEN;
  if (tone === 'warn') return ORANGE;
  if (tone === 'bad') return RED;
  return WHITE;
}

function signed(value: number): string {
  return value >= 0 ? `+${value}` : String(value);
}
