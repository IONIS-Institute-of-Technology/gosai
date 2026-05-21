/**
 * Shared types, constants, and helpers used by the calibration wizard.
 *
 * The wizard runs in two windows simultaneously:
 *   - Projector window (fullscreen on the configured display)
 *   - Control window  (non-fullscreen on the dashboard's display)
 *
 * Both windows load `dist/calibrate.js` and branch on the `role` URL param.
 *
 * Storage keys (per-app under `paths.apps/calibration/_data/storage/`):
 * - `homography`          : 3x3 row-major homography matrix (number[9]) mapping
 *                           camera coords -> display coords. Handles perspective
 *                           (keystone) correction from angled projectors/cameras.
 * - `homography_inverse`  : 3x3 row-major inverse homography (display -> camera).
 * - `focus_quad`          : { points: [{x,y},{x,y},{x,y},{x,y}] } in camera
 *                       coords (top-left, top-right, bottom-right, bottom-left).
 *                       Defines the pool / table area.
 * - `background_jpeg` : base64 JPEG of the empty scene captured by the
 *                       background step.
 * - `markers_layout`  : the marker placement used when the homography was
 *                       computed.
 */

export interface Point2D {
  x: number;
  y: number;
}

export interface FocusQuad {
  points: [Point2D, Point2D, Point2D, Point2D];
}

export interface MarkerSlot {
  id: number;
  x: number;
  y: number;
  size: number;
}

export interface MarkerImage {
  ok: boolean;
  id: number;
  size: number;
  png_base64?: string;
  error?: string;
}

export const STORAGE_KEYS = {
  Homography: 'homography',
  HomographyInverse: 'homography_inverse',
  FocusQuad: 'focus_quad',
  BackgroundJpeg: 'background_jpeg',
  MarkersLayout: 'markers_layout',
} as const;

/**
 * Wizard step machine. Steps run in order; `done` signals the dashboard to
 * close both windows. `abort` is used when the user cancels mid-flow.
 */
export type WizardStep =
  | 'markers'
  | 'pool-corners'
  | 'compute'
  | 'background'
  | 'preview'
  | 'done'
  | 'abort';

/**
 * Events broadcast between the control and projector windows via
 * `rt.events.emit/on`. Topics are namespaced under `wizard:`.
 */
export const WIZARD_EVENTS = {
  /** Emitted by the control window whenever the step changes. */
  Step: 'wizard:step',
  /** Emitted by the control window when corner points change. */
  Corners: 'wizard:corners',
  /** Emitted by the projector window after capture_background completes. */
  BackgroundCaptured: 'wizard:background-captured',
  /** Emitted by the control window when the user aborts. */
  Aborted: 'wizard:aborted',
  /** Emitted when the entire flow completes. Dashboard closes windows. */
  Finished: 'wizard:finished',
  /** Emitted to sync marker pan/zoom between control and projector windows. */
  MarkerTransform: 'wizard:marker-transform',
} as const;

export interface StepEvent {
  step: WizardStep;
  /** Optional human-readable message for status bars. */
  message?: string;
}

export interface CornersEvent {
  /** Pool / table corners in *camera image* normalised coords (0..1). */
  points: Point2D[];
}

export interface MarkerTransform {
  /** Horizontal offset in pixels. */
  offsetX: number;
  /** Vertical offset in pixels. */
  offsetY: number;
  /** Scale factor (1 = no zoom). */
  scale: number;
}

export interface MarkerTransformEvent {
  transform: MarkerTransform;
}

export const DEFAULT_MARKER_TRANSFORM: MarkerTransform = { offsetX: 0, offsetY: 0, scale: 1 };

/** PAN_STEP is in pixels per arrow key press; ZOOM_STEP is the multiplicative factor per wheel tick. */
export const PAN_STEP = 20;
export const ZOOM_STEP = 0.05;
export const MIN_SCALE = 0.2;
export const MAX_SCALE = 3.0;

/**
 * Recompute marker screen positions after applying a transform (pan + zoom).
 * The transform is applied relative to the viewport centre.
 */
export function applyTransformToLayout(
  layout: MarkerSlot[],
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

export function makeMarkerLayout(width: number, height: number, count = 9): MarkerSlot[] {
  const cols = 3;
  const rows = Math.ceil(count / cols);
  const marginX = width * 0.1;
  const marginY = height * 0.1;
  const innerW = width - marginX * 2;
  const innerH = height - marginY * 2;
  const size = Math.min(width, height) * 0.08;

  const out: MarkerSlot[] = [];
  let id = 0;
  for (let r = 0; r < rows && id < count; r++) {
    for (let c = 0; c < cols && id < count; c++) {
      const tx = cols <= 1 ? 0.5 : c / (cols - 1);
      const ty = rows <= 1 ? 0.5 : r / (rows - 1);
      out.push({
        id,
        x: marginX + tx * innerW,
        y: marginY + ty * innerH,
        size,
      });
      id += 1;
    }
  }
  return out;
}

export function setBodyFullscreen(): void {
  document.body.style.margin = '0';
  document.body.style.padding = '0';
  document.body.style.overflow = 'hidden';
  document.body.style.background = '#000';
  document.body.style.color = '#fff';
  document.body.style.fontFamily =
    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
}

/** Quick role detection from URL params. Defaults to `projector`. */
export function detectRole(): 'projector' | 'control' {
  const params = new URLSearchParams(window.location.search);
  return params.get('role') === 'control' ? 'control' : 'projector';
}
