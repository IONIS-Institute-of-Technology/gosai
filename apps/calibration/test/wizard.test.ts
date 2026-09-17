import { describe, expect, test } from 'bun:test';
import type { CameraProjectorSurfaceCalibration } from '@gosai/sdk';
import {
  addCorner,
  advance,
  canAdvance,
  canGoBack,
  cancel,
  computeFailed,
  computeSucceeded,
  frameQuadInDisplay,
  goBack,
  initialWizard,
  mapQuad,
  moveCorner,
  resetCorners,
  saveFailed,
  saveSucceeded,
  toCalibration,
  type ComputeResult,
  type WizardState,
} from '../src/wizard.js';

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const CORNERS = [
  { x: 0.1, y: 0.2 },
  { x: 0.9, y: 0.2 },
  { x: 0.9, y: 0.8 },
  { x: 0.1, y: 0.8 },
];
const CALIBRATION: CameraProjectorSurfaceCalibration = {
  homography: IDENTITY,
  homographyInverse: IDENTITY,
  homographySurface: null,
  homographySurfaceInverse: null,
  focusQuad: null,
  surfaceQuadDisplay: null,
  surfaceSize: { width: 1920, height: 1080 },
  frameSize: null,
};

function atCompute(): WizardState {
  let state = advance(initialWizard(CORNERS));
  expect(state.step).toBe('surface-corners');
  state = advance(state);
  expect(state.step).toBe('compute');
  return state;
}

describe('wizard transitions', () => {
  test('walks markers, corners, compute, preview and done', () => {
    let state = initialWizard();
    expect(state.step).toBe('markers');
    expect(canGoBack(state)).toBe(false);
    state = advance(state);
    expect(state.step).toBe('surface-corners');
    // Four corners are needed before computing.
    expect(canAdvance(state)).toBe(false);
    expect(advance(state)).toBe(state);
    for (const corner of CORNERS) state = addCorner(state, corner);
    expect(addCorner(state, { x: 0.5, y: 0.5 }).corners).toHaveLength(4);
    state = advance(state);
    expect(state.step).toBe('compute');
    state = computeSucceeded(state, CALIBRATION);
    expect(state).toMatchObject({ step: 'preview', calibration: CALIBRATION, error: null });
    // Done starts saving; the step changes once the save settles.
    state = advance(state);
    expect(state).toMatchObject({ step: 'preview', saving: true });
    state = saveSucceeded(state);
    expect(state).toMatchObject({ step: 'done', saving: false });
    expect(cancel(state)).toBe(state);
  });

  test('back, cancel and done do nothing while the profile saves', () => {
    const saving = advance(computeSucceeded(atCompute(), CALIBRATION));
    expect(saving.saving).toBe(true);
    expect(canGoBack(saving)).toBe(false);
    expect(canAdvance(saving)).toBe(false);
    expect(goBack(saving)).toBe(saving);
    expect(cancel(saving)).toBe(saving);
    expect(advance(saving)).toBe(saving);

    // A failed save stays on the preview, with the error, and can be retried or left.
    const failed = saveFailed(saving, 'saving failed: offline');
    expect(failed).toMatchObject({
      step: 'preview',
      saving: false,
      error: 'saving failed: offline',
    });
    expect(goBack(failed).step).toBe('surface-corners');
    expect(cancel(failed).step).toBe('cancelled');
    expect(advance(failed)).toMatchObject({ saving: true, error: null });
    // Settling a save that isn't running changes nothing.
    expect(saveSucceeded(failed)).toBe(failed);
  });

  test('a compute failure returns to the corners with the error, keeping them', () => {
    const state = computeFailed(atCompute(), 'only 2 markers detected');
    expect(state).toMatchObject({
      step: 'surface-corners',
      corners: CORNERS,
      calibration: null,
      error: 'only 2 markers detected',
    });
    // Computing again clears the error.
    expect(advance(state)).toMatchObject({ step: 'compute', error: null });
  });

  test('back and next do nothing while computing', () => {
    const state = atCompute();
    expect(canGoBack(state)).toBe(false);
    expect(canAdvance(state)).toBe(false);
    expect(goBack(state)).toBe(state);
    expect(advance(state)).toBe(state);
  });

  test('back from the preview goes to the corners, not to compute', () => {
    const preview = computeSucceeded(atCompute(), CALIBRATION);
    const back = goBack(preview);
    expect(back).toMatchObject({ step: 'surface-corners', calibration: null, corners: CORNERS });
    expect(goBack(back).step).toBe('markers');
  });

  test('compute results only count during the compute step', () => {
    const corners = advance(initialWizard(CORNERS));
    expect(computeSucceeded(corners, CALIBRATION)).toBe(corners);
    expect(computeFailed(corners, 'late')).toBe(corners);
  });

  test('corners are edited only on the corners step', () => {
    const markers = initialWizard();
    expect(addCorner(markers, { x: 0, y: 0 })).toBe(markers);
    const corners = advance(initialWizard(CORNERS));
    expect(moveCorner(corners, 1, { x: 0.5, y: 0.5 }).corners[1]).toEqual({ x: 0.5, y: 0.5 });
    expect(moveCorner(corners, 7, { x: 0.5, y: 0.5 })).toBe(corners);
    expect(resetCorners(corners).corners).toEqual([]);
    expect(cancel(corners).step).toBe('cancelled');
  });
});

describe('points at infinity', () => {
  // w = x - 100 is zero at x = 100.
  const VANISHING = [1, 0, 0, 0, 1, 0, 1, 0, -100];

  test('a quad with a corner at infinity is rejected', () => {
    expect(frameQuadInDisplay(IDENTITY, { width: 640, height: 480 })).toEqual([
      { x: 0, y: 0 },
      { x: 640, y: 0 },
      { x: 640, y: 480 },
      { x: 0, y: 480 },
    ]);
    expect(frameQuadInDisplay(VANISHING, { width: 100, height: 50 })).toBeNull();
    expect(mapQuad(IDENTITY, CORNERS.slice(0, 3))).toBeNull();
  });

  const result: ComputeResult = {
    matrix: IDENTITY,
    inverse: IDENTITY,
    surface_matrix: IDENTITY,
    surface_inverse: IDENTITY,
    surface_size: { width: 1920, height: 1080 },
    frame_size: { width: 100, height: 100 },
    markers: 9,
    inliers: 36,
    reprojection_error_mean: 0.5,
    reprojection_error_max: 1,
  };

  test('maps the surface corners itself rather than trusting the driver', () => {
    const converted = toCalibration(result, CORNERS);
    expect(converted).toEqual({
      ok: true,
      calibration: {
        homography: IDENTITY,
        homographyInverse: IDENTITY,
        homographySurface: IDENTITY,
        homographySurfaceInverse: IDENTITY,
        focusQuad: [CORNERS[0]!, CORNERS[1]!, CORNERS[2]!, CORNERS[3]!],
        surfaceQuadDisplay: [
          { x: 10, y: 20 },
          { x: 90, y: 20 },
          { x: 90, y: 80 },
          { x: 10, y: 80 },
        ],
        surfaceSize: { width: 1920, height: 1080 },
        frameSize: { width: 100, height: 100 },
      },
    });
  });

  test('a surface corner at infinity fails the compute', () => {
    // The top-right corner is at x = 90 px, where w = 0.
    const converted = toCalibration({ ...result, matrix: [1, 0, 0, 0, 1, 0, 1, 0, -90] }, CORNERS);
    expect(converted.ok).toBe(false);
    expect(!converted.ok && converted.error).toContain('infinity');
  });

  test('without a surface homography there is no surface quad', () => {
    const converted = toCalibration({ ...result, surface_matrix: null, surface_inverse: null }, []);
    expect(converted).toMatchObject({
      ok: true,
      calibration: { focusQuad: null, surfaceQuadDisplay: null, homographySurface: null },
    });
  });
});
