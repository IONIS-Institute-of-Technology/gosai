import { describe, expect, test } from 'bun:test';
import type { DriverTypes } from '@gosai/sdk';
import {
  measureDefaults,
  parseMeasurements,
  type MeasureValues,
} from '../src/calibration/measurements.js';
import {
  CANVAS_PX,
  FIT_ROUNDS,
  GRID_COLUMNS,
  GRID_ROWS,
  HOLDOUT_ROUND,
  MAX_TRIM_PX,
  buildRigProfile,
  candidateGrid,
  chooseSpreadTargets,
  describeCamera,
  distanceHint,
  fitReport,
  holdInstruction,
  lensHint,
  physicalCanvasSize,
  rejectionMessage,
  stepTrim,
  withinBand,
  worstSample,
} from '../src/calibration/wizard/plan.js';
import { buildStatus, type Live, type Phase } from '../src/calibration/wizard/status.js';
import { parseMirrorProfile, type RigMeasurements } from '../src/shared/config.js';

type SolveRigResult = DriverTypes.mirror_calibration.SolveRigResult;

const SCREEN: RigMeasurements = { screen_width_mm: 400, screen_height_mm: 700, gap_mm: 5 };

const SOLVE: SolveRigResult = {
  rig: {
    rotation: [0, 0.1, 0],
    center_mm: [0, -40, 1200],
    width_mm: 392.85,
    height_mm: 698.4,
    gap_mm: 5,
    camera_height_mm: 1700,
    iris_mm: 12.32,
  },
  rms_mm: 2.4,
  residuals_mm: [
    { index: 0, error_mm: 1 },
    { index: 1, error_mm: 4.5 },
    { index: 2, error_mm: null },
  ],
  predicted_error_mm: 9.5,
  condition: 120,
  quality: 'good',
  tilt_deg: -12.5,
  camera_in_screen_mm: [-12, -410, -30],
  distances_mm: [905.2, 1480.1],
  holdout: { count: 3, mean_mm: 8.25, max_mm: 12.75, residuals_mm: [] },
  iris: { apparent_mm: 12.6, near_mm: 12.7, far_mm: 12.5, samples: 10 },
};

const LIVE: Live = {
  busy: false,
  message: '',
  formValues: {},
  formErrors: [],
  eye: 'left',
  storedLens: null,
  lensProgress: 0,
  lensViews: 0,
  lensHint: 'Move the sheet',
  boardSeen: true,
  boardDistanceMm: 620,
  ambiguityMm: 4,
  faceTracked: true,
  viewer: null,
  holdoutMeanMm: null,
  countdown: null,
};

function live(overrides: Partial<Live> = {}): Live {
  return { ...LIVE, ...overrides };
}

describe('the physical canvas size', () => {
  test('is the measured screen when the canvas fills the window', () => {
    const size = physicalCanvasSize(SCREEN, {
      cssWidth: 1080,
      cssHeight: 1890,
      windowWidth: 1080,
      windowHeight: 1890,
    });
    expect(size).toEqual({ width_mm: 400, height_mm: 700 });
  });

  test('is the share of the screen the letterboxed canvas covers', () => {
    // A portrait canvas inside a landscape window: full height, a band of the width.
    const size = physicalCanvasSize(SCREEN, {
      cssWidth: 540,
      cssHeight: 960,
      windowWidth: 1620,
      windowHeight: 960,
    });
    expect(size.width_mm).toBeCloseTo(400 / 3, 6);
    expect(size.height_mm).toBeCloseTo(700, 6);
  });

  test('falls back to the whole screen before the first frame', () => {
    expect(physicalCanvasSize(SCREEN, null)).toEqual({ width_mm: 400, height_mm: 700 });
    const broken = { cssWidth: 0, cssHeight: 0, windowWidth: 0, windowHeight: 0 };
    expect(physicalCanvasSize(SCREEN, broken)).toEqual({ width_mm: 400, height_mm: 700 });
  });
});

describe('target planning', () => {
  test('the candidate grid is inset from the edges of the canvas', () => {
    const grid = candidateGrid();
    expect(grid).toHaveLength(GRID_COLUMNS * GRID_ROWS);
    for (const candidate of grid) {
      expect(candidate.x).toBeGreaterThan(100);
      expect(candidate.x).toBeLessThan(CANVAS_PX[0] - 100);
      expect(candidate.y).toBeGreaterThan(200);
      expect(candidate.y).toBeLessThan(CANVAS_PX[1] - 200);
    }
    expect(new Set(grid.map((c) => c.col)).size).toBe(GRID_COLUMNS);
    expect(new Set(grid.map((c) => c.row)).size).toBe(GRID_ROWS);
  });

  test('picks targets in different rows and columns, spread over the canvas', () => {
    const chosen = chooseSpreadTargets(candidateGrid(), 4);
    expect(chosen).toHaveLength(4);
    expect(new Set(chosen.map((c) => c.row)).size).toBe(4);
    // Three columns and four targets: one column comes back once.
    expect(new Set(chosen.map((c) => c.col)).size).toBe(3);
    const pairs = chosen.flatMap((a, i) => chosen.slice(i + 1).map((b) => distance(a, b)));
    expect(Math.min(...pairs)).toBeGreaterThan(400);
  });

  test('avoids the rows and columns of the targets already captured', () => {
    const grid = candidateGrid();
    const taken = chooseSpreadTargets(grid, 4);
    const next = chooseSpreadTargets(grid, 4, taken);
    for (const candidate of next) {
      expect(taken.some((t) => t.col === candidate.col && t.row === candidate.row)).toBe(false);
    }
    expect(new Set(next.map((c) => c.row)).size).toBe(4);
  });

  test('never returns more than the pool holds', () => {
    const grid = candidateGrid().slice(0, 2);
    expect(chooseSpreadTargets(grid, 4)).toHaveLength(2);
    expect(chooseSpreadTargets([], 4)).toEqual([]);
  });
});

describe('the standing distance', () => {
  test('the two fitted rounds are far enough apart to constrain the rig', () => {
    expect(FIT_ROUNDS[1].distanceMm - FIT_ROUNDS[0].distanceMm).toBeGreaterThan(500);
    expect(FIT_ROUNDS[0].count + FIT_ROUNDS[1].count).toBe(8);
    expect(HOLDOUT_ROUND.holdout).toBe(true);
  });

  test('tells the operator which way to move', () => {
    expect(withinBand(FIT_ROUNDS[0], 950)).toBe(true);
    expect(withinBand(FIT_ROUNDS[0], 1400)).toBe(false);
    expect(withinBand(FIT_ROUNDS[0], null)).toBe(false);
    expect(distanceHint(FIT_ROUNDS[0], null)).toContain('0.90 m');
    expect(distanceHint(FIT_ROUNDS[0], 950)).toBe('Good distance: 0.95 m');
    expect(distanceHint(FIT_ROUNDS[0], 400)).toContain('Step back');
    expect(distanceHint(FIT_ROUNDS[0], 1800)).toContain('Step closer');
  });
});

describe('what the driver says, in plain words', () => {
  test('maps a rejection code to one short line', () => {
    const err = new Error('unstable_board: the board moved 9.1 mm during the last 600 ms');
    expect(rejectionMessage(err)).toBe('The sheet moved. Hold it still, then confirm again.');
    expect(rejectionMessage(new Error('face_missing: only 1 face frames'))).toContain('face');
    // A code nobody planned for keeps its own words.
    expect(rejectionMessage(new Error('weird_code: something else'))).toBe(
      'weird_code: something else',
    );
    expect(rejectionMessage('plain string')).toBe('plain string');
  });

  test('turns the lens hints into instructions', () => {
    expect(lensHint('cover_edges')).toContain('edges');
    expect(lensHint('tilt_board')).toContain('Tilt');
    expect(lensHint('something-else')).toContain('Move the sheet');
  });

  test('says how to hold the sheet', () => {
    expect(holdInstruction('corner_up')).toContain('upright');
    expect(holdInstruction('corner_down')).toContain('half a turn');
    expect(holdInstruction(null)).toContain('camera view');
  });

  test('describes where the fit put the camera', () => {
    expect(describeCamera([-12, -410, -30])).toBe(
      'camera 41 cm above the canvas center, 12 mm to the left',
    );
    // A camera standing well off the mirror plane is worth saying out loud.
    expect(describeCamera([0, -410, -120])).toBe(
      'camera 41 cm above the canvas center, 12 cm in front of the mirror',
    );
    expect(describeCamera([0, 0, 0])).toBe('camera at the canvas center');
    expect(describeCamera([120, 200, 0])).toBe(
      'camera 20 cm below the canvas center, 12 cm to the right',
    );
  });

  test('finds the sample the fit likes least', () => {
    expect(worstSample(SOLVE)).toBe(1);
    expect(worstSample({ ...SOLVE, residuals_mm: [{ index: 3, error_mm: null }] })).toBeNull();
  });
});

describe('the trim', () => {
  test('steps by whole pixels and stops at the limit', () => {
    expect(stepTrim([0, 0], 1, 0)).toEqual([1, 0]);
    expect(stepTrim([0, 0], 0, -5)).toEqual([0, -5]);
    expect(stepTrim([MAX_TRIM_PX, 0], 5, 0)).toEqual([MAX_TRIM_PX, 0]);
    expect(stepTrim([0, -MAX_TRIM_PX], 0, -5)).toEqual([0, -MAX_TRIM_PX]);
  });
});

describe('what the run saves', () => {
  test('reports the fit, including the holdout errors', () => {
    expect(fitReport(SOLVE)).toEqual({
      rms_mm: 2.4,
      predicted_error_mm: 9.5,
      quality: 'good',
      samples: 3,
      holdout_mean_mm: 8.25,
      holdout_max_mm: 12.75,
    });
    expect(fitReport({ ...SOLVE, holdout: null })).toEqual({
      rms_mm: 2.4,
      predicted_error_mm: 9.5,
      quality: 'good',
      samples: 3,
    });
  });

  test('has no report when the alignments left the pose undetermined', () => {
    expect(fitReport({ ...SOLVE, predicted_error_mm: null, quality: 'poor' })).toBeNull();
  });

  test('builds a profile the app can read back', () => {
    const report = fitReport(SOLVE);
    expect(report).not.toBeNull();
    const profile = buildRigProfile({
      rig: SOLVE.rig,
      fit: report!,
      measurements: { ...SCREEN, camera_height_mm: 1700 },
      trim: [3, -2],
      updatedAt: 1234,
    });
    expect(profile).toMatchObject({
      version: 2,
      trim_px: [3, -2],
      measurements: { ...SCREEN, camera_height_mm: 1700 },
      updatedAt: 1234,
    });
    expect(profile.fit.holdout_mean_mm).toBe(8.25);
    // It has to survive the parser the app loads profiles with.
    expect(parseMirrorProfile(JSON.parse(JSON.stringify(profile)))).toEqual(profile);
  });

  test('keeps the camera height the operator measured, and none when they skipped it', () => {
    const report = fitReport(SOLVE)!;
    const build = (rig: SolveRigResult['rig'], measurements: RigMeasurements) =>
      buildRigProfile({ rig, fit: report, measurements, trim: [0, 0], updatedAt: 1 });
    // The driver carries it into the rig it returns.
    expect(build(SOLVE.rig, SCREEN).rig.camera_height_mm).toBe(1700);
    // An older driver answer falls back to what was typed.
    const without = { ...SOLVE.rig, camera_height_mm: null };
    expect(build(without, { ...SCREEN, camera_height_mm: 1650 }).rig.camera_height_mm).toBe(1650);
    // Nobody measured it: the floor cue stays off rather than being guessed.
    expect(build(without, SCREEN).rig.camera_height_mm).toBeNull();
  });

  test('falls back to the measured gap when the driver reports none', () => {
    const report = fitReport(SOLVE)!;
    const rig = { ...SOLVE.rig, gap_mm: undefined };
    const profile = buildRigProfile({
      rig,
      fit: report,
      measurements: SCREEN,
      trim: [0, 0],
      updatedAt: 1,
    });
    expect(profile.rig.gap_mm).toBe(SCREEN.gap_mm);
  });
});

describe('the snapshot each screen publishes', () => {
  const align: Phase = {
    kind: 'align',
    round: FIT_ROUNDS[0],
    targets: [{ candidate: { x: 540, y: 900, col: 1, row: 3 }, hold: 'corner_down' }],
    index: 0,
    eyeDistanceMm: 940,
    reachable: 12,
    reason: null,
    startedAt: 0,
  };

  test('the alignment screen asks for the other eye, the hold and what is tracked', () => {
    // `eye` is the one that stays open, so the left-eye operator closes the right.
    const status = buildStatus(align, live());
    expect(status.phase).toBe('align');
    expect(status.lines[0]).toBe('Close your RIGHT eye.');
    expect(buildStatus(align, live({ eye: 'right' })).lines[0]).toBe('Close your LEFT eye.');
    expect(status.lines[2]).toContain('half a turn');
    expect(status.progress).toEqual({ done: 0, total: 4, label: 'target 1 of 4' });
    expect(status.readings.map((reading) => `${reading.label} ${reading.value}`)).toEqual([
      'sheet seen',
      'sheet distance 62 cm',
      'face tracked',
    ]);
  });

  test('offers a capture, a timed capture and an undo, each only when it is usable', () => {
    const fresh = buildStatus(align, live());
    expect(actions(fresh)).toEqual({
      capture: true,
      'capture-in': true,
      undo: false,
      cancel: true,
    });
    expect(fresh.actions.filter((action) => action.primary).map((a) => a.command)).toEqual([
      'capture',
    ]);
    // Mid-round, the last capture can be dropped; while the driver answers, nothing can.
    expect(actions(buildStatus({ ...align, index: 1 }, live()))['undo']).toBe(true);
    expect(actions(buildStatus(align, live({ busy: true })))['capture']).toBe(false);
  });

  test('an uncertain board pose asks for a tilt, and a lost board has no distance', () => {
    const shaky = buildStatus(align, live({ ambiguityMm: 22, boardSeen: false }));
    expect(shaky.readings.map((reading) => `${reading.label} ${reading.value}`)).toEqual([
      'sheet not seen',
      'sheet distance unknown',
      'face tracked',
      'sheet pose uncertain, tilt it a little',
    ]);
  });

  test('with no targets planned it says how to become reachable', () => {
    const waiting = buildStatus({ ...align, targets: [], reachable: 2 }, live());
    expect(waiting.lines).toContain('Step back a little, or hold the sheet higher.');
    expect(waiting.readings.at(-1)).toEqual({
      label: 'targets you can reach',
      value: '2',
      ok: false,
    });
    expect(actions(waiting)['capture']).toBe(false);
  });

  test("the driver's reason replaces the guess about why nothing is reachable", () => {
    const blind = buildStatus({ ...align, targets: [], reason: 'no_face' }, live());
    expect(blind.lines).toContain('Face the camera so your face is tracked.');
    expect(blind.lines).not.toContain('Step back a little, or hold the sheet higher.');

    const close = buildStatus({ ...align, targets: [], reason: 'too_close' }, live());
    expect(close.lines.join(' ')).toContain(
      'Step back: there is no room to hold the board in front of you.',
    );
  });

  test('the fit screen leads with the expected error and how to fix a poor one', () => {
    const report = fitReport(SOLVE);
    const good = buildStatus({ kind: 'result', stage: 'fit', solve: SOLVE, report }, live());
    expect(good.title).toBe('Mirror fitted: good');
    expect(good.headline).toEqual({ text: '10 mm', tone: 'good' });
    expect(actions(good)['continue']).toBe(true);

    const solve = { ...SOLVE, quality: 'poor' as const, predicted_error_mm: 46 };
    const poor = buildStatus({ kind: 'result', stage: 'fit', solve, report: null }, live());
    expect(poor.headline?.text).toBe('46 mm');
    expect(poor.lines).toContain('Usually one of these:');
    // Nothing leads on from a fit that says nothing about itself.
    expect(actions(poor)['continue']).toBe(false);
    expect(actions(poor)['add-targets']).toBe(true);
  });

  test('the fit screen says what the operator’s iris read and what the rig will assume', () => {
    const report = fitReport(SOLVE);
    const status = buildStatus({ kind: 'result', stage: 'fit', solve: SOLVE, report }, live());
    const iris = status.readings.find((reading) => reading.label === 'iris');
    // What the camera read, and the shrunk value the mirror will size strangers with.
    expect(iris).toEqual({
      label: 'iris',
      value: 'reads 12.6 mm (assumed 12.3 mm)',
      ok: true,
    });

    // A reading that follows the range cannot be one diameter for everybody.
    const split = { ...SOLVE, iris: { ...SOLVE.iris, near_mm: 12.6, far_mm: 11.4 } };
    const warned = buildStatus(
      { kind: 'result', stage: 'fit', solve: split, report: fitReport(split) },
      live(),
    ).readings.find((reading) => reading.label === 'iris');
    expect(warned?.ok).toBe(false);
    expect(warned?.value).toContain('10 percent apart near and far');

    // Nothing measured: the generic diameter, and said to be generic.
    const none = {
      ...SOLVE,
      rig: { ...SOLVE.rig, iris_mm: 11.7 },
      iris: { apparent_mm: null, near_mm: null, far_mm: null, samples: 0 },
    };
    const unread = buildStatus(
      { kind: 'result', stage: 'fit', solve: none, report: fitReport(none) },
      live(),
    ).readings.find((reading) => reading.label === 'iris');
    expect(unread).toEqual({ label: 'iris', value: 'not read (assuming 11.7 mm)', ok: false });
  });

  test('the check screen leads with the holdout error, not the fit residual', () => {
    const report = fitReport(SOLVE)!;
    const status = buildStatus({ kind: 'result', stage: 'holdout', solve: SOLVE, report }, live());
    expect(status.phase).toBe('holdout');
    expect(status.headline).toEqual({ text: '8 mm average', tone: 'good' });
    expect(status.lines[0]).toBe('worst of the 3: 13 mm');
    expect(status.lines[1]).toContain('2.4 mm rms');
    expect(actions(status)['continue']).toBe(true);
  });

  test('the verify screen carries the trim, the checked error and what the driver sees', () => {
    const viewer = {
      left_eye_mm: [0, 0, 1200],
      right_eye_mm: [60, 0, 1200],
      eye_source: 'face' as const,
      body_scale: 0.94,
      scale_cues: { eyes: 0.97, iris: 0.91, floor: null },
      distance_mm: 1200,
      capture_ts: 1,
      ts: 2,
    };
    const status = buildStatus(
      { kind: 'verify', trim: [3, -40] },
      live({ viewer, holdoutMeanMm: 8.25 }),
    );
    expect(status.trim).toEqual([3, -40]);
    expect(status.lines).toContain('checked error: 8 mm average');
    expect(status.lines.at(-1)).toContain('A trim this large');
    const readings = Object.fromEntries(status.readings.map((r) => [r.label, r.value]));
    expect(readings['body size']).toBe('0.94 of average');
    // All three size cues, so the operator can see which ones are alive. The
    // feet are what a camera too high to see them loses.
    expect(readings['pupils']).toBe('0.97');
    expect(readings['iris']).toBe('0.91');
    expect(readings['feet']).toBe('not seen');
    expect(status.readings.find((r) => r.label === 'feet')?.ok).toBe(false);
    expect(actions(status)).toEqual({ save: true, restart: true, cancel: true });
  });

  test('a countdown rides along with whatever is on screen', () => {
    expect(buildStatus(align, live({ countdown: 3 })).countdown).toBe(3);
    expect(buildStatus(align, live()).countdown).toBeNull();
  });

  test('the measurement form travels with its prefilled values and its errors', () => {
    const status = buildStatus(
      { kind: 'measure' },
      live({ formValues: { gap_mm: '5' }, formErrors: ['Active screen width (mm): nope'] }),
    );
    expect(status.form).toEqual({
      values: { gap_mm: '5' },
      errors: ['Active screen width (mm): nope'],
    });
    expect(actions(status)).toEqual({ cancel: true });
  });
});

describe('the measurement form', () => {
  const values: MeasureValues = {
    screen_width_mm: '392.85',
    screen_height_mm: '698.4',
    gap_mm: '5',
    camera_height_mm: '1720',
    ipd_mm: '63.5',
    eye: 'left',
  };

  test('accepts numbers inside their ranges', () => {
    expect(parseMeasurements(values)).toEqual({
      ok: true,
      value: {
        measurements: {
          screen_width_mm: 392.85,
          screen_height_mm: 698.4,
          gap_mm: 5,
          camera_height_mm: 1720,
        },
        ipdMm: 63.5,
        eye: 'left',
      },
    });
  });

  test('takes an empty camera height as the floor cue turned off', () => {
    const result = parseMeasurements({ ...values, camera_height_mm: '  ' });
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.measurements.camera_height_mm).toBeUndefined();
  });

  test('takes a comma as a decimal point and defaults the eye to the right one', () => {
    const result = parseMeasurements({ ...values, ipd_mm: '63,5', eye: '' });
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.ipdMm).toBe(63.5);
    expect(result.ok && result.value.eye).toBe('right');
  });

  test('reports every field that is out of range, and none that are fine', () => {
    const result = parseMeasurements({
      ...values,
      screen_width_mm: '20',
      gap_mm: '500',
      camera_height_mm: '4000',
      ipd_mm: 'abc',
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.errors).toHaveLength(4);
    expect(result.ok === false && result.errors[0]).toContain('100 and 3000');
  });

  test('offers the previous measurements and the default pupil distance again', () => {
    expect(measureDefaults({ ...SCREEN, camera_height_mm: 1720 }, 66, 'left')).toEqual({
      screen_width_mm: '400',
      screen_height_mm: '700',
      gap_mm: '5',
      camera_height_mm: '1720',
      ipd_mm: '66',
      eye: 'left',
    });
    // A first run has no sizes to offer, and a thin mirror gap is the usual case.
    expect(measureDefaults(null, 63, 'right')).toMatchObject({
      screen_width_mm: '',
      gap_mm: '5',
      camera_height_mm: '',
      ipd_mm: '63',
    });
  });
});

/** Which commands a screen offers, and whether each one can be used. */
function actions(status: {
  actions: readonly { command: string; enabled: boolean }[];
}): Record<string, boolean> {
  return Object.fromEntries(status.actions.map((action) => [action.command, action.enabled]));
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
