/**
 * Helpers shared by the control and projector windows. See the README for the
 * flow and the profile it saves.
 */

import type {
  CalibrationQuad,
  CameraProjectorSurfaceOptions,
  CameraProjectorSurfaceStep,
} from '@gosai/sdk';

/** The projector's marker pan and zoom, which the control window owns. */
export const MARKER_TRANSFORM_TOPIC = 'wizard:marker-transform';

/** Payload of the `wizard:step` topic the control window broadcasts. */
export type StepEvent =
  | { readonly step: Exclude<CameraProjectorSurfaceStep, 'preview'> | 'done' | 'cancelled' }
  | {
      readonly step: 'preview';
      readonly homography: readonly number[];
      readonly surfaceQuadDisplay: CalibrationQuad | null;
    };

/** Markers the projector draws. */
export const MARKER_COUNT = 9;

export interface MarkerSlot {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly size: number;
}

export interface MarkerTransform {
  /** Horizontal offset in pixels. */
  readonly offsetX: number;
  /** Vertical offset in pixels. */
  readonly offsetY: number;
  /** Scale factor (1 = no zoom). */
  readonly scale: number;
}

export const DEFAULT_MARKER_TRANSFORM: MarkerTransform = { offsetX: 0, offsetY: 0, scale: 1 };

/** Pixels per arrow key press. */
export const PAN_STEP = 20;
/** Scale change per wheel tick. */
export const ZOOM_STEP = 0.05;
export const MIN_SCALE = 0.2;
export const MAX_SCALE = 3.0;

const DEFAULT_CORNER_LABELS = ['TL', 'TR', 'BR', 'BL'] as const;

export function cornerLabels(
  options: CameraProjectorSurfaceOptions,
): readonly [string, string, string, string] {
  return options.cornerLabels ?? DEFAULT_CORNER_LABELS;
}

/** Marker positions after a pan and zoom around the viewport centre. */
export function applyTransformToLayout(
  layout: readonly MarkerSlot[],
  transform: MarkerTransform,
  viewportW: number,
  viewportH: number,
): MarkerSlot[] {
  const cx = viewportW / 2;
  const cy = viewportH / 2;
  return layout.map((slot) => ({
    ...slot,
    x: cx + (slot.x - cx) * transform.scale + transform.offsetX,
    y: cy + (slot.y - cy) * transform.scale + transform.offsetY,
    size: slot.size * transform.scale,
  }));
}

/** A 3-column grid of markers inside a 10% margin. */
export function makeMarkerLayout(
  width: number,
  height: number,
  count = MARKER_COUNT,
): MarkerSlot[] {
  const cols = 3;
  const rows = Math.ceil(count / cols);
  const marginX = width * 0.1;
  const marginY = height * 0.1;
  const innerW = width - marginX * 2;
  const innerH = height - marginY * 2;
  const size = Math.min(width, height) * 0.08;

  const out: MarkerSlot[] = [];
  for (let id = 0; id < count; id++) {
    const c = id % cols;
    const r = Math.floor(id / cols);
    const ty = rows <= 1 ? 0.5 : r / (rows - 1);
    out.push({ id, x: marginX + (c / (cols - 1)) * innerW, y: marginY + ty * innerH, size });
  }
  return out;
}

export function setBodyFullscreen(background: string): void {
  const style = document.body.style;
  style.margin = '0';
  style.padding = '0';
  style.overflow = 'hidden';
  style.background = background;
  style.color = '#fff';
  style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
}
