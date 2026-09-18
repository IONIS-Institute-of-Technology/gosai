/**
 * The camera-projector-surface wizard as pure state transitions, driven by
 * the control window:
 *
 *   markers -> surface-corners -> compute -> preview -> done
 *
 * A failed compute returns to the corners, and Back from the preview goes to
 * the corners too, since the homography is computed again from them.
 */

import {
  perspectiveTransformPoint,
  type CalibrationPoint,
  type CalibrationQuad,
  type CalibrationSize,
  type CameraProjectorSurfaceCalibration,
  type CameraProjectorSurfaceStep,
  type DriverTypes,
} from '@gosai/sdk';

export type WizardStep = CameraProjectorSurfaceStep | 'done' | 'cancelled';

export interface WizardState {
  readonly step: WizardStep;
  /** Surface corners picked so far, in normalised camera coordinates. */
  readonly corners: readonly CalibrationPoint[];
  /** The computed calibration, shown in the preview and saved at the end. */
  readonly calibration: CameraProjectorSurfaceCalibration | null;
  /** Why the last compute or save failed. */
  readonly error: string | null;
  /** The profile is being saved. Nothing else happens until that settles. */
  readonly saving: boolean;
}

export function initialWizard(corners: readonly CalibrationPoint[] = []): WizardState {
  return {
    step: 'markers',
    corners: corners.slice(0, 4),
    calibration: null,
    error: null,
    saving: false,
  };
}

export function canAdvance(state: WizardState): boolean {
  switch (state.step) {
    case 'markers':
      // Partial detection is allowed; the compute step reports too few markers.
      return true;
    case 'surface-corners':
      return state.corners.length === 4;
    case 'preview':
      return state.calibration !== null && !state.saving;
    default:
      return false;
  }
}

export function canGoBack(state: WizardState): boolean {
  return !state.saving && (state.step === 'surface-corners' || state.step === 'preview');
}

export function advance(state: WizardState): WizardState {
  if (!canAdvance(state)) return state;
  switch (state.step) {
    case 'markers':
      return { ...state, step: 'surface-corners' };
    case 'surface-corners':
      return { ...state, step: 'compute', error: null };
    case 'preview':
      // Done starts the save; `saveSucceeded` or `saveFailed` settle it.
      return { ...state, saving: true, error: null };
    default:
      return state;
  }
}

export function saveSucceeded(state: WizardState): WizardState {
  if (!state.saving) return state;
  return { ...state, step: 'done', saving: false };
}

export function saveFailed(state: WizardState, error: string): WizardState {
  if (!state.saving) return state;
  return { ...state, saving: false, error };
}

export function goBack(state: WizardState): WizardState {
  if (state.saving) return state;
  switch (state.step) {
    case 'surface-corners':
      return { ...state, step: 'markers', error: null };
    case 'preview':
      return { ...state, step: 'surface-corners', calibration: null };
    default:
      return state;
  }
}

export function computeSucceeded(
  state: WizardState,
  calibration: CameraProjectorSurfaceCalibration,
): WizardState {
  if (state.step !== 'compute') return state;
  return { ...state, step: 'preview', calibration, error: null };
}

export function computeFailed(state: WizardState, error: string): WizardState {
  if (state.step !== 'compute') return state;
  return { ...state, step: 'surface-corners', calibration: null, error };
}

/** Cancels, except once the flow is over or while the profile saves. */
export function cancel(state: WizardState): WizardState {
  if (state.saving || state.step === 'done' || state.step === 'cancelled') return state;
  return { ...state, step: 'cancelled' };
}

/** Adds a corner, up to four. */
export function addCorner(state: WizardState, corner: CalibrationPoint): WizardState {
  if (state.step !== 'surface-corners' || state.corners.length >= 4) return state;
  return { ...state, corners: [...state.corners, corner] };
}

export function moveCorner(
  state: WizardState,
  index: number,
  corner: CalibrationPoint,
): WizardState {
  if (state.step !== 'surface-corners' || index < 0 || index >= state.corners.length) return state;
  return { ...state, corners: state.corners.map((p, i) => (i === index ? corner : p)) };
}

export function resetCorners(state: WizardState): WizardState {
  return state.step === 'surface-corners' ? { ...state, corners: [] } : state;
}

/**
 * Maps a quad through a homography. `null` when a corner maps to infinity,
 * which no display or CSS transform can show.
 */
export function mapQuad(
  homography: readonly number[],
  quad: readonly CalibrationPoint[],
): CalibrationQuad | null {
  const mapped = quad.map((p) => perspectiveTransformPoint(homography, p.x, p.y));
  const [a, b, c, d] = mapped;
  return a && b && c && d && mapped.length === 4 ? [a, b, c, d] : null;
}

/** The corners of a camera frame in display pixels, or `null` when one maps to infinity. */
export function frameQuadInDisplay(
  homography: readonly number[],
  frame: CalibrationSize,
): CalibrationQuad | null {
  const { width, height } = frame;
  return mapQuad(homography, [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: height },
    { x: 0, y: height },
  ]);
}

/**
 * The profile data for a compute result. The surface corners are mapped to
 * the display here, from the corners the user placed, and a corner at
 * infinity fails with an error the wizard can show.
 */
export function toCalibration(
  result: Pick<
    DriverTypes.calibration.ComputeResult,
    'matrix' | 'inverse' | 'surface_matrix' | 'surface_inverse' | 'surface_size' | 'frame_size'
  >,
  corners: readonly CalibrationPoint[],
): { ok: true; calibration: CameraProjectorSurfaceCalibration } | { ok: false; error: string } {
  const frame = result.frame_size;
  const [a, b, c, d] = corners;
  const focusQuad: CalibrationQuad | null = a && b && c && d ? [a, b, c, d] : null;
  let surfaceQuadDisplay: CalibrationQuad | null = null;
  if (focusQuad && frame && result.surface_matrix) {
    const pixels = focusQuad.map((p) => ({ x: p.x * frame.width, y: p.y * frame.height }));
    surfaceQuadDisplay = mapQuad(result.matrix, pixels);
    if (!surfaceQuadDisplay) {
      return {
        ok: false,
        error:
          'a surface corner maps to infinity on the display; check the corners and that the markers were detected correctly',
      };
    }
  }
  return {
    ok: true,
    calibration: {
      homography: result.matrix,
      homographyInverse: result.inverse,
      homographySurface: result.surface_matrix,
      homographySurfaceInverse: result.surface_inverse,
      focusQuad,
      surfaceQuadDisplay,
      surfaceSize: result.surface_size,
      frameSize: frame,
    },
  };
}
