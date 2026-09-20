/**
 * The wizard's phases, and the snapshot both windows are drawn from.
 *
 * The mirror owns the run: it holds the phase, talks to the drivers and, after
 * every change, publishes a {@link WizardStatus} that says what the operator
 * should read, what they may do next and what is live right now. The control
 * window turns that into DOM and sends commands back; the mirror turns the
 * same thing into large type on the glass. Keeping the wording here means the
 * two windows can never disagree about where the run is.
 */

import type { DriverTypes } from '@gosai/sdk';
import type { StatusAction, StatusReading, WizardStatus } from '../channel.js';
import type { Eye } from '../measurements.js';
import { GENERIC_IRIS_MM, type RigFitReport, type StoredLens } from '../../shared/config.js';
import {
  POOR_FIT_REASONS,
  TRIM_WARN_PX,
  describeCamera,
  distanceHint,
  holdInstruction,
  qualityWord,
  type Candidate,
  type Round,
} from './plan.js';

type SolveRigResult = DriverTypes.mirror_calibration.SolveRigResult;
type ViewerPayload = DriverTypes.pose_to_mirror.ViewerPayload;
type Hold = DriverTypes.mirror_calibration.TargetSuggestion['hold'];
type Reason = DriverTypes.mirror_calibration.SuggestTargetsResult['reason'];

/** Above this the planar board pose has a second solution worth worrying about. */
export const AMBIGUITY_WARN_MM = 15;
/** Holdout errors up to these read as good and as usable, in millimeters. */
const GOOD_ERROR_MM = 15;
const FAIR_ERROR_MM = 30;
/**
 * Above this gap between the near and far halves of the iris readings, what
 * the landmark model reads depends on how big the iris is in the picture, and
 * one assumed diameter cannot be right at both distances.
 */
const IRIS_RANGE_WARN = 0.08;

/** One target of a round, and how the driver says to hold the sheet for it. */
export interface PlannedTarget {
  readonly candidate: Candidate;
  hold: Hold;
}

export interface AlignPhase {
  readonly kind: 'align';
  readonly round: Round;
  /** Empty while the wizard is still waiting for a set it can reach. */
  targets: readonly PlannedTarget[];
  index: number;
  eyeDistanceMm: number | null;
  reachable: number;
  /** Why the driver tested nothing, when that is what it answered. */
  reason: Reason;
  startedAt: number;
}

export interface ResultPhase {
  readonly kind: 'result';
  /** `fit` is the rig itself, `holdout` the error on targets it never saw. */
  readonly stage: 'fit' | 'holdout';
  readonly solve: SolveRigResult;
  /** Null when the alignments left the pose undetermined: nothing to save. */
  readonly report: RigFitReport | null;
}

export interface VerifyPhase {
  readonly kind: 'verify';
  trim: [number, number];
}

export type Phase =
  | { readonly kind: 'measure' }
  | { readonly kind: 'lens-choice' }
  | { readonly kind: 'lens-capture' }
  | {
      readonly kind: 'lens-result';
      readonly rmsPx: number;
      readonly hfovDeg: number;
      readonly views: number;
    }
  | { readonly kind: 'lens-failed' }
  | AlignPhase
  | { readonly kind: 'solving' }
  | ResultPhase
  | { readonly kind: 'no-fit' }
  | VerifyPhase
  | { readonly kind: 'saving' }
  | { readonly kind: 'leaving' };

/** Everything outside the phase that the snapshot is a function of. */
export interface Live {
  /** A driver call is in flight, so the buttons that would race it are off. */
  readonly busy: boolean;
  /** A rejection or a hint, in the operator's words. */
  readonly message: string;
  /** The values the measurement form opens with, and what it got wrong. */
  readonly formValues: Readonly<Record<string, string>>;
  readonly formErrors: readonly string[];
  /** The eye the operator keeps open. */
  readonly eye: Eye;
  /** The lens on file, for the reuse screen. */
  readonly storedLens: StoredLens | null;
  readonly lensProgress: number;
  readonly lensViews: number;
  readonly lensHint: string;
  readonly boardSeen: boolean;
  readonly boardDistanceMm: number | null;
  readonly ambiguityMm: number | null;
  readonly faceTracked: boolean;
  /** The driver's own view of the visitor, read while the fit is checked. */
  readonly viewer: ViewerPayload | null;
  /** Mean error over the targets kept out of the fit, once there is one. */
  readonly holdoutMeanMm: number | null;
  /** Seconds left of a timed capture. */
  readonly countdown: number | null;
}

/** The snapshot both windows draw. */
export function buildStatus(phase: Phase, live: Live): WizardStatus {
  const base = {
    headline: null,
    progress: null,
    readings: [],
    form: null,
    countdown: live.countdown,
    trim: null,
    message: live.message,
  } as const;
  switch (phase.kind) {
    case 'measure':
      return {
        ...base,
        phase: 'measure',
        title: 'Mirror calibration: measurements',
        lines: [
          'Print the sheet at 100 percent and check the printed ruler reads 100 mm.',
          'Glue it to something flat and rigid.',
        ],
        actions: [action('cancel', 'Cancel', { key: 'Esc' })],
        form: { values: live.formValues, errors: live.formErrors },
      };
    case 'lens-choice':
      return {
        ...base,
        phase: 'lens-choice',
        title: 'The camera lens is already calibrated',
        lines: [
          lensAge(live.storedLens),
          'Reuse it unless the camera, its settings or the glass',
          'in front of it changed.',
        ],
        actions: [
          action('reuse-lens', 'Reuse the saved lens', { primary: true, key: 'Enter' }),
          action('recalibrate-lens', 'Calibrate the lens again'),
          action('cancel', 'Cancel', { key: 'Esc' }),
        ],
      };
    case 'lens-capture':
      return {
        ...base,
        phase: 'lens-capture',
        title: 'Lens calibration',
        lines: [live.lensHint],
        progress: {
          done: Math.round(live.lensProgress * 100),
          total: 100,
          label: `${live.lensViews} views kept`,
        },
        readings: [seenReading(live)],
        actions: [action('cancel', 'Cancel', { key: 'Esc' })],
      };
    case 'lens-result':
      return {
        ...base,
        phase: 'lens-result',
        title: 'Lens calibrated',
        headline: { text: `${phase.rmsPx.toFixed(2)} px`, tone: 'good' },
        lines: [
          `reprojection error over ${phase.views} views`,
          `field of view ${phase.hfovDeg.toFixed(0)} degrees`,
        ],
        actions: [
          action('continue', 'Line up the targets', { primary: true, key: 'Enter' }),
          action('cancel', 'Cancel', { key: 'Esc' }),
        ],
      };
    case 'lens-failed':
      return {
        ...base,
        phase: 'lens-failed',
        title: 'The lens fit failed',
        lines: ['Move the sheet through more of the picture,', 'and tilt it away from the camera.'],
        actions: [
          action('recalibrate-lens', 'Try the lens again', { primary: true, key: 'Enter' }),
          action('cancel', 'Cancel', { key: 'Esc' }),
        ],
      };
    case 'align':
      return alignStatus(phase, live, base);
    case 'solving':
      return {
        ...base,
        phase: 'solving',
        title: 'Fitting the mirror',
        lines: [],
        actions: [action('cancel', 'Cancel', { key: 'Esc' })],
      };
    case 'result':
      return resultStatus(phase, live, base);
    case 'no-fit':
      return {
        ...base,
        phase: 'no-fit',
        title: 'No usable fit',
        lines: ['Usually one of these:', ...POOR_FIT_REASONS.map((reason) => `- ${reason}`)],
        actions: [
          action('add-targets', 'Four more targets at a third distance', {
            primary: true,
            key: 'Enter',
          }),
          action('restart', 'Start the alignment over'),
          action('cancel', 'Cancel', { key: 'Esc' }),
        ],
      };
    case 'verify':
      return {
        ...base,
        phase: 'verify',
        title: 'Does the skeleton sit on your reflection?',
        lines: [
          'Both eyes open now. Move closer and further,',
          'and from side to side. A flat display only lines up',
          'with one eye at a time, so expect a small split.',
          ...(live.holdoutMeanMm === null
            ? []
            : [`checked error: ${live.holdoutMeanMm.toFixed(0)} mm average`]),
          ...(trimWarned(phase.trim)
            ? ['A trim this large points to a poor fit, not to a perceptual nudge.']
            : []),
        ],
        readings: viewerReadings(live),
        trim: [...phase.trim],
        actions: [
          action('save', 'Save the calibration', { primary: true, key: 'Enter' }),
          action('restart', 'Start the alignment over'),
          action('cancel', 'Leave without saving', { key: 'Esc' }),
        ],
      };
    case 'saving':
      return { ...base, phase: 'saving', title: 'Saving', lines: [], actions: [] };
    case 'leaving':
      return {
        ...base,
        phase: 'leaving',
        title: 'Leaving the calibration',
        lines: [],
        actions: [],
      };
    default: {
      const exhaustive: never = phase;
      throw new Error(`unhandled phase ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** Whether a trim that large is covering for the fit rather than for a perception. */
export function trimWarned(trim: readonly [number, number]): boolean {
  return Math.abs(trim[0]) > TRIM_WARN_PX || Math.abs(trim[1]) > TRIM_WARN_PX;
}

type StatusBase = Pick<
  WizardStatus,
  'headline' | 'progress' | 'readings' | 'form' | 'countdown' | 'trim' | 'message'
>;

function alignStatus(phase: AlignPhase, live: Live, base: StatusBase): WizardStatus {
  const target = phase.targets[phase.index];
  const count = phase.round.count;
  const readings: StatusReading[] = [
    seenReading(live),
    {
      label: 'sheet distance',
      value:
        live.boardSeen && live.boardDistanceMm !== null
          ? `${(live.boardDistanceMm / 10).toFixed(0)} cm`
          : 'unknown',
      ok: live.boardSeen && live.boardDistanceMm !== null,
    },
    { label: 'face', value: live.faceTracked ? 'tracked' : 'not tracked', ok: live.faceTracked },
  ];
  if (live.ambiguityMm !== null && live.ambiguityMm > AMBIGUITY_WARN_MM) {
    readings.push({ label: 'sheet pose', value: 'uncertain, tilt it a little', ok: false });
  }
  if (!target) {
    readings.push({
      label: 'targets you can reach',
      value: String(phase.reachable),
      ok: phase.reachable >= count,
    });
  }
  return {
    ...base,
    phase: 'align',
    title: phase.round.title,
    lines: target
      ? [
          // `eye` is the one that stays open, so the reminder names the other.
          `Close your ${live.eye === 'left' ? 'RIGHT' : 'LEFT'} eye.`,
          'Put the reflection of the ORIGIN corner on the mark.',
          holdInstruction(target.hold),
          distanceHint(phase.round, phase.eyeDistanceMm),
        ]
      : [distanceHint(phase.round, phase.eyeDistanceMm), ...reachLines(phase)],
    progress: {
      done: phase.index,
      total: count,
      label: `target ${Math.min(phase.index + 1, count)} of ${count}`,
    },
    readings,
    actions: [
      action('capture', 'Capture', {
        primary: true,
        key: 'Space',
        enabled: target !== undefined && !live.busy,
      }),
      action('capture-in', 'Capture after a countdown', {
        key: 'T',
        enabled: target !== undefined && !live.busy,
      }),
      action('undo', 'Undo the last capture', {
        key: 'Backspace',
        enabled: phase.index > 0 && !live.busy,
      }),
      action('cancel', 'Cancel', { key: 'Esc' }),
    ],
  };
}

/**
 * The two lines above the count, while no target has been planned yet. The
 * driver says why it could test nothing, so the screen asks for the one thing
 * that would help instead of guessing at it.
 */
function reachLines(phase: AlignPhase): [string, string] {
  if (phase.reason === 'no_face') {
    return ['Face the camera so your face is tracked.', 'The targets follow where your eyes are.'];
  }
  if (phase.reason === 'too_close') {
    return ['Step back: there is no room to hold', 'the board in front of you.'];
  }
  if (phase.reachable < phase.round.count) {
    return [
      'Too few targets can be reached from there.',
      'Step back a little, or hold the sheet higher.',
    ];
  }
  return ['Looking for targets you can reach…', ''];
}

/**
 * The fit, or the check on targets it never saw. The holdout error is the
 * headline there, because it is the only number that was not fitted.
 */
function resultStatus(phase: ResultPhase, live: Live, base: StatusBase): WizardStatus {
  const solve = phase.solve;
  const poor = phase.report === null || solve.quality === 'poor';
  const holdout = solve.holdout;
  if (phase.stage === 'holdout' && holdout && holdout.mean_mm !== null) {
    const worst = holdout.max_mm === null ? 'not measurable' : `${holdout.max_mm.toFixed(0)} mm`;
    return {
      ...base,
      phase: 'holdout',
      title: 'Checked against targets the fit never saw',
      headline: {
        text: `${holdout.mean_mm.toFixed(0)} mm average`,
        tone: errorTone(holdout.mean_mm),
      },
      lines: [
        `worst of the ${holdout.count}: ${worst}`,
        `the fit's own error: ${solve.rms_mm.toFixed(1)} mm rms`,
        '',
        'This is the number to trust.',
      ],
      actions: [
        action('continue', 'Check it on your reflection', {
          primary: true,
          key: 'Enter',
          enabled: !poor,
        }),
        action('restart', 'Start the alignment over'),
        action('cancel', 'Cancel', { key: 'Esc' }),
      ],
    };
  }
  const predicted = solve.predicted_error_mm;
  return {
    ...base,
    phase: 'fit',
    readings: [irisReading(solve)],
    title: `Mirror fitted: ${qualityWord(solve.quality)}`,
    headline: {
      text: predicted === null ? 'undetermined' : `${predicted.toFixed(0)} mm`,
      tone: poor ? 'bad' : solve.quality === 'good' ? 'good' : 'warn',
    },
    lines: [
      'expected alignment error',
      `${solve.rms_mm.toFixed(1)} mm rms over ${solve.residuals_mm.length} targets`,
      `tilt ${solve.tilt_deg.toFixed(1)} degrees`,
      `${describeCamera(solve.camera_in_screen_mm)}, as you face the mirror`,
      `standing distances used: ${solve.distances_mm.map(meters).join(', ')}`,
      ...(poor ? ['', 'Usually one of these:', ...POOR_FIT_REASONS.map((why) => `- ${why}`)] : []),
    ],
    actions: [
      action('continue', 'Check on three targets the fit will not use', {
        primary: true,
        key: 'Enter',
        enabled: !poor,
      }),
      action('add-targets', 'Four more targets at a third distance'),
      action('redo-worst', 'Take the worst target again', { enabled: !live.busy }),
      action('restart', 'Start the alignment over'),
      action('cancel', 'Cancel', { key: 'Esc' }),
    ],
  };
}

/**
 * What the operator's own irises read on this camera, and what the rig will
 * therefore assume for strangers. A run that read none says so instead of
 * showing the generic value as though it had been measured.
 */
function irisReading(solve: SolveRigResult): StatusReading {
  const assumed = (solve.rig.iris_mm ?? GENERIC_IRIS_MM).toFixed(1);
  const { apparent_mm, near_mm, far_mm } = solve.iris;
  if (apparent_mm === null) {
    return { label: 'iris', value: `not read (assuming ${assumed} mm)`, ok: false };
  }
  const reading = `reads ${apparent_mm.toFixed(1)} mm (assumed ${assumed} mm)`;
  const gap = rangeGap(near_mm, far_mm);
  if (gap === null || gap <= IRIS_RANGE_WARN) return { label: 'iris', value: reading, ok: true };
  return {
    label: 'iris',
    value: `${reading}, ${(gap * 100).toFixed(0)} percent apart near and far`,
    ok: false,
  };
}

/** How far the near and far halves of the readings are apart, as a fraction. */
function rangeGap(near: number | null, far: number | null): number | null {
  if (near === null || far === null || near <= 0 || far <= 0) return null;
  return Math.abs(near - far) / ((near + far) / 2);
}

/**
 * What the driver makes of the visitor in front of it, so the operator can see
 * which size cues are alive while they judge the drawing. The pupil spacing is
 * always there, the iris whenever the face is close enough to read, the feet
 * only when the camera is low enough to see them.
 */
function viewerReadings(live: Live): StatusReading[] {
  const viewer = live.viewer;
  if (!viewer) return [{ label: 'the driver sees', value: 'nobody yet', ok: false }];
  const cues = viewer.scale_cues;
  return [
    { label: 'body size', value: `${viewer.body_scale.toFixed(2)} of average`, ok: true },
    cueReading('pupils', cues.eyes),
    cueReading('iris', cues.iris),
    cueReading('feet', cues.floor),
    {
      label: 'eyes',
      value: viewer.eye_source === 'none' ? 'not tracked' : `from the ${viewer.eye_source}`,
      ok: viewer.eye_source !== 'none',
    },
  ];
}

/** One size cue's own answer, against MediaPipe's average body. */
function cueReading(label: string, scale: number | null): StatusReading {
  return {
    label,
    value: scale === null ? 'not seen' : scale.toFixed(2),
    ok: scale !== null,
  };
}

function seenReading(live: Live): StatusReading {
  return { label: 'sheet', value: live.boardSeen ? 'seen' : 'not seen', ok: live.boardSeen };
}

function lensAge(stored: StoredLens | null): string {
  if (!stored) return 'no lens on file';
  const rms = stored.lens.rms_px;
  const when = new Date(stored.updatedAt).toLocaleDateString();
  return `${rms === null || rms === undefined ? 'no error reported' : `${rms.toFixed(2)} px error`}, ${when}`;
}

function errorTone(mm: number): 'good' | 'warn' | 'bad' {
  if (mm <= GOOD_ERROR_MM) return 'good';
  return mm <= FAIR_ERROR_MM ? 'warn' : 'bad';
}

function meters(mm: number): string {
  return `${(mm / 1000).toFixed(2)} m`;
}

function action(
  command: StatusAction['command'],
  label: string,
  options: { readonly primary?: boolean; readonly key?: string; readonly enabled?: boolean } = {},
): StatusAction {
  return {
    command,
    label,
    enabled: options.enabled ?? true,
    primary: options.primary ?? false,
    key: options.key ?? '',
  };
}
