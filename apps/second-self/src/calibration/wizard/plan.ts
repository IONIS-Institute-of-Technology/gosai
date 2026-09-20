/**
 * The wizard's decisions, without a canvas or a driver: where the targets go,
 * how much of the screen the reference canvas covers, what the driver's
 * rejection codes mean in plain words, and what a finished run saves.
 *
 * The wizard (../wizard.ts) keeps the conversation with the drivers and the
 * phase it is in; everything here is a function of its inputs, so it can be
 * read and tested on its own.
 */

import type { DriverTypes } from '@gosai/sdk';
import {
  GENERIC_IRIS_MM,
  TRIM_LIMIT_PX,
  type MirrorProfile,
  type RigFitReport,
  type RigMeasurements,
} from '../../shared/config.js';
import { REF_HEIGHT, REF_WIDTH } from '../../shared/types.js';

type SolveRigResult = DriverTypes.mirror_calibration.SolveRigResult;
type RigProfile = DriverTypes.mirror_calibration.RigProfile;
type Hold = DriverTypes.mirror_calibration.TargetSuggestion['hold'];

/** The canvas the driver is told about, as `[width, height]` in pixels. */
export const CANVAS_PX: readonly [number, number] = [REF_WIDTH, REF_HEIGHT];

// ---------------------------------------------------------------------------
// Physical canvas size

export interface CanvasLayout {
  /** CSS width of the reference canvas inside the window. */
  readonly cssWidth: number;
  readonly cssHeight: number;
  readonly windowWidth: number;
  readonly windowHeight: number;
}

/** The physical size of the area the reference canvas covers, in millimeters. */
export interface PhysicalCanvas {
  readonly width_mm: number;
  readonly height_mm: number;
}

/**
 * How large the reference canvas is in millimeters. The fit fills the window
 * along one axis and letterboxes the other, so the canvas covers a fraction of
 * the measured screen; the driver wants that area, not the whole screen. This
 * assumes the window fills the display that was measured.
 */
export function physicalCanvasSize(
  screen: RigMeasurements,
  layout: CanvasLayout | null,
): PhysicalCanvas {
  const width = layout ? coverage(layout.cssWidth, layout.windowWidth) : 1;
  const height = layout ? coverage(layout.cssHeight, layout.windowHeight) : 1;
  return {
    width_mm: screen.screen_width_mm * width,
    height_mm: screen.screen_height_mm * height,
  };
}

/** The fraction of a window side the canvas covers. Nonsense sizes mean all of it. */
function coverage(canvas: number, window: number): number {
  if (!(canvas > 0) || !(window > 0)) return 1;
  return Math.min(1, canvas / window);
}

// ---------------------------------------------------------------------------
// Target planning

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** One place a target may go, and where it sits in the candidate grid. */
export interface Candidate extends Point {
  readonly col: number;
  readonly row: number;
}

export const GRID_COLUMNS = 3;
export const GRID_ROWS = 6;
/** Inset from the edges: a target on the edge is neither reachable nor readable. */
const INSET_X = 150;
const INSET_TOP = 280;
const INSET_BOTTOM = 240;

/** The places a target may be drawn, left to right and top to bottom. */
export function candidateGrid(): Candidate[] {
  const grid: Candidate[] = [];
  const spanX = REF_WIDTH - 2 * INSET_X;
  const spanY = REF_HEIGHT - INSET_TOP - INSET_BOTTOM;
  for (let row = 0; row < GRID_ROWS; row++) {
    for (let col = 0; col < GRID_COLUMNS; col++) {
      grid.push({
        x: INSET_X + (col / (GRID_COLUMNS - 1)) * spanX,
        y: INSET_TOP + (row / (GRID_ROWS - 1)) * spanY,
        col,
        row,
      });
    }
  }
  return grid;
}

/** How much a target loses for sharing a row or a column with one already taken. */
const CLASH_PENALTY = 0.6;

/**
 * `count` of the `candidates`, spread as widely as the grid allows: each pick
 * is the one farthest from everything already taken, and sharing a row or a
 * column with a taken target counts against it. A fit needs the targets spread
 * over the canvas; several in one row or column leave the rig loose.
 */
export function chooseSpreadTargets(
  candidates: readonly Candidate[],
  count: number,
  taken: readonly Candidate[] = [],
): Candidate[] {
  const pool = candidates.filter(
    (candidate) =>
      !taken.some((other) => other.col === candidate.col && other.row === candidate.row),
  );
  const middle = centroid(candidates);
  const chosen: Candidate[] = [];
  while (chosen.length < count && pool.length > 0) {
    const occupied = [...taken, ...chosen];
    let bestIndex = 0;
    let bestScore = -Infinity;
    for (const [index, candidate] of pool.entries()) {
      const score = spreadScore(candidate, occupied, middle);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }
    chosen.push(...pool.splice(bestIndex, 1));
  }
  return chosen;
}

function spreadScore(candidate: Candidate, occupied: readonly Candidate[], middle: Point): number {
  const others: readonly Point[] = occupied.length > 0 ? occupied : [middle];
  let nearest = Infinity;
  for (const other of others) {
    nearest = Math.min(nearest, Math.hypot(candidate.x - other.x, candidate.y - other.y));
  }
  const rowClash = occupied.some((other) => other.row === candidate.row);
  const colClash = occupied.some((other) => other.col === candidate.col);
  return nearest * (rowClash ? CLASH_PENALTY : 1) * (colClash ? CLASH_PENALTY : 1);
}

function centroid(points: readonly Point[]): Point {
  if (points.length === 0) return { x: REF_WIDTH / 2, y: REF_HEIGHT / 2 };
  let x = 0;
  let y = 0;
  for (const point of points) {
    x += point.x;
    y += point.y;
  }
  return { x: x / points.length, y: y / points.length };
}

// ---------------------------------------------------------------------------
// Rounds

/** One pass over a few targets, taken from one standing distance. */
export interface Round {
  readonly key: 'near' | 'far' | 'extra' | 'holdout' | 'redo';
  /** Where the operator should stand, measured from the mirror. */
  readonly distanceMm: number;
  readonly count: number;
  /** Kept out of the fit, so the error can be measured on it afterwards. */
  readonly holdout: boolean;
  readonly title: string;
}

/**
 * The two distances every run takes. One distance fits its own targets just as
 * well as two and still leaves the rig loosely constrained, so both are
 * required rather than recommended.
 */
export const FIT_ROUNDS: readonly [Round, Round] = [
  {
    key: 'near',
    distanceMm: 900,
    count: 4,
    holdout: false,
    title: 'Round 1 of 2: stand close to the mirror',
  },
  {
    key: 'far',
    distanceMm: 1500,
    count: 4,
    holdout: false,
    title: 'Round 2 of 2: stand further back',
  },
];

/** Offered when the fit came out poor: four more targets at a third distance. */
export const EXTRA_ROUND: Round = {
  key: 'extra',
  distanceMm: 1200,
  count: 4,
  holdout: false,
  title: 'Four more targets, at a distance between the first two',
};

/** The honest check: targets the fit never sees. */
export const HOLDOUT_ROUND: Round = {
  key: 'holdout',
  distanceMm: 1200,
  count: 3,
  holdout: true,
  title: 'Check: three targets the fit never sees',
};

/** How far from the wanted distance still counts as standing there. */
export const BAND_TOLERANCE_MM = 250;

export function withinBand(round: Round, eyeDistanceMm: number | null): boolean {
  return eyeDistanceMm !== null && Math.abs(eyeDistanceMm - round.distanceMm) <= BAND_TOLERANCE_MM;
}

/** What to tell the operator about where they are standing. */
export function distanceHint(round: Round, eyeDistanceMm: number | null): string {
  const wanted = meters(round.distanceMm);
  if (eyeDistanceMm === null) return `Stand about ${wanted} from the mirror, facing it`;
  const here = meters(eyeDistanceMm);
  if (withinBand(round, eyeDistanceMm)) return `Good distance: ${here}`;
  const move = eyeDistanceMm < round.distanceMm ? 'Step back' : 'Step closer';
  return `${move}: ${here} now, about ${wanted} wanted`;
}

function meters(mm: number): string {
  return `${(mm / 1000).toFixed(2)} m`;
}

/** How to hold the sheet for a target, from the driver's answer. */
export function holdInstruction(hold: Hold): string {
  if (hold === 'corner_up') return 'Hold the sheet upright, ORIGIN corner at the top left';
  if (hold === 'corner_down') return 'Turn the sheet half a turn, ORIGIN corner at the bottom';
  return 'Hold the sheet so the whole of it stays in the camera view';
}

// ---------------------------------------------------------------------------
// Driver answers in plain words

const REJECTIONS: Readonly<Record<string, string>> = {
  board_missing: 'The camera lost the sheet. Keep all of it in view, then confirm again.',
  face_missing: 'The camera lost your face. Keep it in view, then confirm again.',
  unstable_board: 'The sheet moved. Hold it still, then confirm again.',
  unstable_eye: 'Your head moved. Stand still, then confirm again.',
  ambiguous_board: 'The sheet pose is uncertain. Tilt it a little, then confirm again.',
  no_valid_rig: 'The targets do not pin the mirror down.',
  busy_lens: 'The lens is still being solved.',
  unknown_alignment: 'That target was already removed.',
};

/**
 * A short line for a driver rejection. The driver raises `code: explanation`;
 * the code is what the wizard can say something useful about, and the rest is
 * kept when it is a code nobody planned for.
 */
export function rejectionMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const code = raw.split(':', 1)[0]?.trim() ?? '';
  return REJECTIONS[code] ?? raw;
}

const LENS_HINTS: Readonly<Record<string, string>> = {
  more_views: 'Move the sheet to a new place and hold it there',
  cover_edges: 'Bring the sheet near the edges and the corners of the picture',
  tilt_board: 'Tilt the sheet away from the camera, in different directions',
  ready: 'Enough views, solving',
};

export function lensHint(hint: string): string {
  return LENS_HINTS[hint] ?? 'Move the sheet slowly through the camera view';
}

/** Below this an offset says nothing: it is inside the measurement error. */
const NEGLIGIBLE_MM = 5;
/**
 * The camera sits in the mirror plane give or take its own thickness, so only
 * a real standoff is worth a phrase on a screen read from two metres away.
 */
const NEGLIGIBLE_DEPTH_MM = 50;

/**
 * Where the fit put the camera, as a sanity check against where it is bolted.
 * The screen frame has `u` to the right and `v` down as the viewer sees the
 * canvas, and `w` away from the viewer, behind the mirror.
 */
export function describeCamera(position: readonly number[]): string {
  const [u = 0, v = 0, w = 0] = position;
  const parts: string[] = [];
  if (Math.abs(v) >= NEGLIGIBLE_MM) {
    parts.push(`${lengthText(v)} ${v < 0 ? 'above' : 'below'} the canvas center`);
  }
  if (Math.abs(u) >= NEGLIGIBLE_MM)
    parts.push(`${lengthText(u)} to the ${u < 0 ? 'left' : 'right'}`);
  if (Math.abs(w) >= NEGLIGIBLE_DEPTH_MM) {
    parts.push(`${lengthText(w)} ${w < 0 ? 'in front of' : 'behind'} the mirror`);
  }
  if (parts.length === 0) return 'camera at the canvas center';
  return `camera ${parts.join(', ')}`;
}

function lengthText(mm: number): string {
  const abs = Math.abs(mm);
  return abs >= 100 ? `${(abs / 10).toFixed(0)} cm` : `${abs.toFixed(0)} mm`;
}

const QUALITY_WORDS: Readonly<Record<SolveRigResult['quality'], string>> = {
  good: 'good',
  fair: 'fair, usable',
  poor: 'poor',
};

export function qualityWord(quality: SolveRigResult['quality']): string {
  return QUALITY_WORDS[quality];
}

/** Why a fit usually comes out poor, in the order worth checking. */
export const POOR_FIT_REASONS: readonly string[] = [
  'the two standing distances were too close to each other',
  'the targets sat in the same rows or columns',
  'the other eye was open, or it changed during the run',
  'the screen size or the gap was typed in wrong',
];

/** The fitted sample with the largest residual, for a redo. */
export function worstSample(solve: SolveRigResult): number | null {
  let worst: number | null = null;
  let error = -Infinity;
  for (const residual of solve.residuals_mm) {
    const value = residual.error_mm;
    if (value !== null && value > error) {
      error = value;
      worst = residual.index;
    }
  }
  return worst;
}

// ---------------------------------------------------------------------------
// Trim

/**
 * How far the verify screen lets the trim pull the drawing: the same limit the
 * profile clamps a stored trim to, so what is dialled in is what is saved.
 */
export const MAX_TRIM_PX = TRIM_LIMIT_PX;
/** A trim this large is a sign of a poor fit rather than a perceptual nudge. */
export const TRIM_WARN_PX = 25;

export function stepTrim(
  trim: readonly [number, number],
  dx: number,
  dy: number,
): [number, number] {
  return [clampTrim(trim[0] + dx), clampTrim(trim[1] + dy)];
}

function clampTrim(value: number): number {
  return Math.max(-MAX_TRIM_PX, Math.min(MAX_TRIM_PX, Math.round(value)));
}

// ---------------------------------------------------------------------------
// What the run saves

/**
 * The fit as the profile stores it, or `null` when the alignments left the
 * pose undetermined: the driver reports no predicted error then, and a profile
 * without one says nothing about how well the mirror is calibrated.
 */
export function fitReport(solve: SolveRigResult): RigFitReport | null {
  const predicted = solve.predicted_error_mm;
  if (predicted === null) return null;
  const holdout = solve.holdout;
  const mean = holdout?.mean_mm ?? null;
  const max = holdout?.max_mm ?? null;
  return {
    rms_mm: solve.rms_mm,
    predicted_error_mm: predicted,
    quality: solve.quality,
    samples: solve.residuals_mm.length,
    ...(mean === null ? {} : { holdout_mean_mm: mean }),
    ...(max === null ? {} : { holdout_max_mm: max }),
  };
}

export interface ProfileInput {
  readonly rig: RigProfile;
  readonly fit: RigFitReport;
  /** As the operator typed them, so the next run can offer them again. */
  readonly measurements: RigMeasurements;
  readonly trim: readonly [number, number];
  readonly updatedAt: number;
}

export function buildRigProfile(input: ProfileInput): MirrorProfile {
  return {
    version: 2,
    rig: {
      rotation: [...input.rig.rotation],
      center_mm: [...input.rig.center_mm],
      width_mm: input.rig.width_mm,
      height_mm: input.rig.height_mm,
      gap_mm: input.rig.gap_mm ?? input.measurements.gap_mm,
      // The fit carries the measured camera height through, so the driver has
      // the floor cue without the app assembling the rig itself.
      camera_height_mm: input.rig.camera_height_mm ?? input.measurements.camera_height_mm ?? null,
      // The fit measured this on the operator. It describes how this camera
      // reads an iris, not their own, so it belongs with the rig.
      iris_mm: input.rig.iris_mm ?? GENERIC_IRIS_MM,
    },
    trim_px: [input.trim[0], input.trim[1]],
    measurements: input.measurements,
    fit: input.fit,
    updatedAt: input.updatedAt,
  };
}
