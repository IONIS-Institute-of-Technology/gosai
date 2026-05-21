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
 * - `homography`             : 3x3 row-major homography matrix (number[9])
 *                              mapping camera pixels -> display pixels.
 *                              Handles perspective (keystone) correction from
 *                              angled projectors/cameras.
 * - `homography_inverse`     : 3x3 row-major inverse homography
 *                              (display -> camera).
 * - `homography_surface`     : 3x3 row-major homography mapping camera pixels
 *                              -> SURFACE reference space (apps' canonical
 *                              coordinate space, default 1920x1080). This is
 *                              what tracking drivers (`ball`, `hand_pose`)
 *                              should consume.
 * - `homography_surface_inverse` : inverse of the above.
 * - `focus_quad`             : { points: [{x,y}, ...] } in NORMALISED camera
 *                              coords (0..1, top-left, top-right, bottom-right,
 *                              bottom-left). Defines the physical surface in
 *                              the camera view.
 * - `surface_quad_display`   : { points: [{x,y}, ...] } - the same 4 corners
 *                              after applying the camera->display homography.
 *                              Used by apps to drive CSS `matrix3d` keystone
 *                              correction so the rendered canvas lands exactly
 *                              on the physical surface.
 * - `surface_size`           : { width, height } - the surface reference
 *                              resolution (default 1920x1080).
 * - `frame_size`             : { width, height } - the camera frame size that
 *                              was active when the homography was computed.
 *                              Required by drivers to denormalise inputs.
 * - `markers_layout`         : the marker placement used when the homography
 *                              was computed.
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
  HomographySurface: 'homography_surface',
  HomographySurfaceInverse: 'homography_surface_inverse',
  FocusQuad: 'focus_quad',
  SurfaceQuadDisplay: 'surface_quad_display',
  SurfaceSize: 'surface_size',
  FrameSize: 'frame_size',
  MarkersLayout: 'markers_layout',
} as const;

/** Default surface (canvas / app reference) resolution. */
export const DEFAULT_SURFACE_SIZE = { width: 1920, height: 1080 } as const;

export interface SizeXY {
  readonly width: number;
  readonly height: number;
}

export interface SurfaceQuadDisplay {
  /** Four corners (TL, TR, BR, BL) of the physical surface in display
   * (projector) pixels, derived by applying the camera->display homography to
   * the user-picked `focus_quad`. */
  readonly points: [Point2D, Point2D, Point2D, Point2D];
}

/**
 * Wizard step machine. Steps run in order; `done` signals the dashboard to
 * close both windows. `abort` is used when the user cancels mid-flow.
 */
export type WizardStep =
  | 'markers'
  | 'pool-corners'
  | 'compute'
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
