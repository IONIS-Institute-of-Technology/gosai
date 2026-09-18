/**
 * Mirror calibration wizard (reflection mode).
 *
 * Guides the user through fitting the `pose_to_mirror` reflection projection
 * to the physical rig, with zero numbers to type:
 *
 * 1. A target dot is drawn at a known reference-space position. The user
 *    aligns their index fingertip's *reflection* with the dot and holds still;
 *    stability is detected on the raw camera-space fingertip (the on-screen
 *    projection is exactly what is not calibrated yet), and the driver
 *    captures a median-filtered sample (`capture_calibration_sample`).
 * 2. After the first round the user steps back and repeats a short second
 *    round; the depth variation pins down the camera tilt and the
 *    distance-estimate scale.
 * 3. `solve_calibration` grid-searches tilt x scale and solves the mm->pixel
 *    affine, applying the fit live. The verify screen then shows the (now
 *    calibrated) skeleton on the reflection with dwell buttons to save the
 *    profile or redo the run.
 *
 * It runs in the calibration experience (src/calibrate.ts). The Back button
 * at the top leaves at any time before saving. However it ends, unless the
 * fit was saved, the driver goes back to the saved projection and results
 * still in flight are dropped.
 */

import type { CalibrationResult, DriverActionResult, ExperienceRuntimeContext } from '@gosai/sdk';
import { CALIBRATION_CANCELLED } from '../shared/calibration.js';
import { drawText, fillCircle, strokeCircle } from '../shared/draw.js';
import type { MirrorFeed } from '../shared/feed.js';
import { drawBody } from '../shared/mirror.js';
import type { Projection } from '../shared/projection.js';
import { REF_HEIGHT, REF_WIDTH, type Layer } from '../shared/types.js';
import {
  CursorPicker,
  drawHoverButton,
  drawProgressRing,
  inRect,
  stepDwell,
  type Point,
  type Rect,
} from '../shared/ui.js';

// Body-pose index fingertips (MediaPipe indices).
const LEFT_INDEX = 19;
const RIGHT_INDEX = 20;

// Capture tuning.
const HOLD_MS = 1000;
/** Delay after a target appears before a hold can begin (time to move + aim). */
const TARGET_COOLDOWN_MS = 1500;
const STILLNESS_FRAC = 0.03; // max deviation from the window mean, in frame diagonals.
/**
 * A hold only arms once a fingertip moved this far (frame diagonals) from
 * where it was when the target appeared: a hand that is already resting still
 * (after the intro or the step-back screen) must not fill the hold before the
 * user actually reaches for the new dot. Double the stillness tolerance so
 * idle jitter cannot arm it.
 */
const ARM_MOVE_FRAC = 0.06;
const MIN_FINGER_VIS = 0.4;
const RAW_FRESH_MS = 500;
/** Minimum time the intro stays up (people need to read it). */
const INTRO_MIN_MS = 8000;
const INTRO_STABLE_MS = 3000;
const STEPBACK_SPAN_CHANGE = 0.12; // fractional shoulder-span change that counts as "moved".
const STEPBACK_STABLE_MS = 1000;
/** Minimum time the step-back screen stays up. */
const STEPBACK_MIN_MS = 4000;
/** How long a solve-failure screen stays up before restarting. */
const FAIL_SHOW_MS = 8000;
const VERIFY_DWELL_MS = 1400;
/** Longer than the other buttons: leaving drops the run. */
const BACK_DWELL_MS = 1800;

// Targets in reference space, avoiding the Back button at the top.
const ROUND1: ReadonlyArray<readonly [number, number]> = [
  [200, 420],
  [880, 420],
  [540, 900],
  [200, 1500],
  [880, 1500],
];
const ROUND2: ReadonlyArray<readonly [number, number]> = [
  [540, 520],
  [240, 1100],
  [840, 1100],
];

const ORANGE = '#ff8100';
const GREEN = '#a6d854';
const DIM = 'rgba(255,255,255,0.65)';
const RING_GREEN = { color: GREEN, lineWidth: 8 };

type Phase =
  'intro' | 'capture' | 'stepback' | 'solving' | 'verify' | 'saving' | 'failed' | 'leaving';

type SolveResult = DriverActionResult<'pose_to_mirror', 'solve_calibration'>;

const SAVE_BUTTON: Rect = { x: 150, y: 1580, w: 340, h: 130 };
const REDO_BUTTON: Rect = { x: 590, y: 1580, w: 340, h: 130 };
const BACK_BUTTON: Rect = { x: 390, y: 60, w: 300, h: 120 };

export interface WizardDeps {
  readonly rt: ExperienceRuntimeContext;
  readonly feed: MirrorFeed;
  readonly projection: Projection;
  /** Called once per run: with `ok` once the profile is saved, cancelled from Back. */
  finish(result: CalibrationResult): void;
}

export function createMirrorWizard(deps: WizardDeps): Layer {
  let phase: Phase = 'intro';
  let round: 1 | 2 = 1;
  let targetIdx = 0;
  let targetShownAt = 0;
  let message = '';
  let pending = false;
  let phaseStartedAt = 0;
  /**
   * Bumped whenever the run resets or the layer stops, so a capture or solve
   * that settles afterwards can tell it belongs to an abandoned run.
   */
  let run = 0;
  /** Aborts the remaining steps of a save when the run resets or the layer stops. */
  let saving: AbortController | null = null;

  // Stability window over the raw fingertip: [x, y, timestamp].
  let holdWindow: Array<[number, number, number]> = [];
  // Body index fingertip (19/20) locked at hold start, so the tracked point
  // never jumps between hands mid-hold; passed to the driver on capture.
  let holdLandmark: number | null = null;
  // Fingertip positions snapshotted when the current target appeared. The
  // hold stays disarmed until the tracked tip moves away from its snapshot,
  // so a hand still resting from the previous dot/screen cannot trigger a
  // capture before the user actually aims at the new dot.
  let armAnchors: Record<number, [number, number] | null> = {};
  let holdArmed = false;
  let introStableSince = 0;
  // Shoulder span (raw px) medians per capture, used for step-back detection.
  let round1Spans: number[] = [];
  let stepbackSince = 0;
  let stepbackStableSince = 0;

  let fit: SolveResult | null = null;
  let saved = false;
  let failReason = '';

  // Dwell state of the Back button and the verify screen's buttons.
  const cursorPicker = new CursorPicker({ bodyFallback: true });
  let backDwellMs = 0;
  let saveDwellMs = 0;
  let redoDwellMs = 0;

  function reset(): void {
    run += 1;
    saving?.abort();
    saving = null;
    phase = 'intro';
    round = 1;
    targetIdx = 0;
    targetShownAt = 0;
    message = '';
    pending = false;
    phaseStartedAt = performance.now();
    holdWindow = [];
    holdLandmark = null;
    armAnchors = {};
    holdArmed = false;
    introStableSince = 0;
    round1Spans = [];
    stepbackSince = 0;
    stepbackStableSince = 0;
    fit = null;
    failReason = '';
    cursorPicker.reset();
    backDwellMs = 0;
    saveDwellMs = 0;
    redoDwellMs = 0;
  }

  function targets(): ReadonlyArray<readonly [number, number]> {
    return round === 1 ? ROUND1 : ROUND2;
  }

  function capturedCount(): number {
    return round === 1 ? targetIdx : ROUND1.length + targetIdx;
  }

  function totalTargets(): number {
    return ROUND1.length + ROUND2.length;
  }

  // -- raw-feed helpers -------------------------------------------------------

  function rawFresh(now: number): boolean {
    return now - deps.feed.raw.lastUpdate < RAW_FRESH_MS;
  }

  function bodyPresent(now: number): boolean {
    const body = deps.feed.raw.data.body_pose;
    return rawFresh(now) && body.length > 0 && (body[0]?.[2] ?? 0) > 0.5;
  }

  /** Raw camera-space position of a body landmark, if visible enough. */
  function rawLandmark(index: number): [number, number] | null {
    const lm = deps.feed.raw.data.body_pose[index];
    if (!lm || (lm[2] ?? 0) < MIN_FINGER_VIS) return null;
    return [lm[0]!, lm[1]!];
  }

  /** The more visible index fingertip, used to lock a new hold onto one hand. */
  function pickHoldLandmark(): number | null {
    const body = deps.feed.raw.data.body_pose;
    const lv = body[LEFT_INDEX]?.[2] ?? 0;
    const rv = body[RIGHT_INDEX]?.[2] ?? 0;
    if (Math.max(lv, rv) < MIN_FINGER_VIS) return null;
    return rv >= lv ? RIGHT_INDEX : LEFT_INDEX;
  }

  function shoulderSpan(): number | null {
    const body = deps.feed.raw.data.body_pose;
    const l = body[11];
    const r = body[12];
    if (!l || !r || (l[2] ?? 0) < 0.5 || (r[2] ?? 0) < 0.5) return null;
    return Math.hypot(l[0]! - r[0]!, l[1]! - r[1]!);
  }

  function frameDiagonal(): number {
    const { frame_width, frame_height } = deps.feed.raw.data;
    return Math.hypot(frame_width, frame_height);
  }

  // -- capture logic ----------------------------------------------------------

  /** Show the current target: reset the aim cooldown and disarm the hold. */
  function showTarget(now: number): void {
    targetShownAt = now;
    holdArmed = false;
    armAnchors = {
      [LEFT_INDEX]: rawLandmark(LEFT_INDEX),
      [RIGHT_INDEX]: rawLandmark(RIGHT_INDEX),
    };
  }

  /** Returns hold progress 0..1; manages the stability window. */
  function updateHold(now: number): number {
    if (!bodyPresent(now) || now - targetShownAt < TARGET_COOLDOWN_MS) {
      holdWindow = [];
      holdLandmark = null;
      return 0;
    }
    if (holdLandmark === null) holdLandmark = pickHoldLandmark();
    const landmark = holdLandmark;
    const tip = landmark === null ? null : rawLandmark(landmark);
    if (!tip || landmark === null) {
      holdWindow = [];
      holdLandmark = null;
      return 0;
    }
    if (!holdArmed) {
      // A fingertip that was already resting when the target appeared must
      // travel toward the new dot before holding still starts to count. A tip
      // with no anchor (hand was down/hidden) arms by becoming visible.
      const anchor = armAnchors[landmark] ?? null;
      const moved =
        anchor === null ||
        Math.hypot(tip[0] - anchor[0], tip[1] - anchor[1]) > ARM_MOVE_FRAC * frameDiagonal();
      if (!moved) {
        holdWindow = [];
        return 0;
      }
      holdArmed = true;
    }
    holdWindow.push([tip[0], tip[1], now]);
    holdWindow = holdWindow.filter(([, , ts]) => now - ts <= HOLD_MS);

    const n = holdWindow.length;
    if (n < 3) return 0;
    let mx = 0;
    let my = 0;
    for (const [x, y] of holdWindow) {
      mx += x;
      my += y;
    }
    mx /= n;
    my /= n;
    const tolerance = STILLNESS_FRAC * frameDiagonal();
    for (const [x, y] of holdWindow) {
      if (Math.hypot(x - mx, y - my) > tolerance) {
        // Moving: restart the window from the freshest position.
        holdWindow = holdWindow.slice(-1);
        return 0;
      }
    }
    const span = now - holdWindow[0]![2];
    return Math.min(1, span / HOLD_MS);
  }

  function captureTarget(target: readonly [number, number]): void {
    if (pending) return;
    pending = true;
    message = '';
    const span = shoulderSpan();
    const captureRun = run;
    deps.rt.drivers
      .execute('pose_to_mirror', 'capture_calibration_sample', {
        target: [target[0], target[1]],
        ...(holdLandmark !== null ? { landmark: holdLandmark } : {}),
      })
      .then(
        () => {
          if (captureRun !== run) return;
          if (round === 1 && span !== null) round1Spans.push(span);
          advanceTarget();
        },
        (err: unknown) => {
          if (captureRun !== run) return;
          // The driver rejects with a user-facing reason (too few frames, hand not visible).
          message = err instanceof Error ? err.message : 'capture failed, hold still and retry';
          deps.rt.log.warn('calibrate: capture failed', { err: String(err) });
        },
      )
      .finally(() => {
        if (captureRun !== run) return;
        pending = false;
        holdWindow = [];
        holdLandmark = null;
      });
  }

  function advanceTarget(): void {
    targetIdx += 1;
    showTarget(performance.now());
    if (targetIdx < targets().length) return;
    if (round === 1) {
      phase = 'stepback';
      stepbackSince = performance.now();
      stepbackStableSince = 0;
    } else {
      phase = 'solving';
      solve();
    }
  }

  function clearSamples(): void {
    deps.rt.drivers.execute('pose_to_mirror', 'clear_calibration_samples').catch(() => undefined);
  }

  function solveFailed(error: string): void {
    clearSamples();
    message = '';
    fit = null;
    phase = 'failed';
    phaseStartedAt = performance.now();
    deps.rt.log.warn('calibrate: solve failed', { error });
    // Keep the reason for the failure screen.
    failReason = error;
  }

  // No `pending` guard here: solve() is invoked exactly once (from
  // advanceTarget, while the capture promise that called it is still marked
  // pending) and re-entry is prevented by the 'solving' phase itself.
  function solve(): void {
    const solveRun = run;
    void (async () => {
      const result = await deps.rt.drivers.execute('pose_to_mirror', 'solve_calibration');
      if (solveRun !== run) return;
      // The verify overlay must show the fitted reflection projection, even
      // when the wizard was launched from direct mode.
      await deps.rt.drivers
        .execute('pose_to_mirror', 'set_mirror_config', { mode: 'reflection' })
        .catch(() => undefined);
      if (solveRun !== run) return;
      fit = result;
      phase = 'verify';
      saveDwellMs = 0;
      redoDwellMs = 0;
    })().catch((err: unknown) => {
      if (solveRun === run) solveFailed(err instanceof Error ? err.message : String(err));
    });
  }

  function restartRun(): void {
    clearSamples();
    const keep = message;
    reset();
    message = keep;
  }

  function saveAndFinish(): void {
    if (!fit || phase === 'saving') return;
    const [ax = 0, bx = 0, ay = 0, by = 0] = fit.affine;
    const profile = {
      tilt_deg: fit.tilt_deg,
      scale: fit.scale,
      affine: [ax, bx, ay, by] as const,
      residual_px_mean: fit.residual_px_mean,
      updatedAt: Date.now(),
    };
    phase = 'saving';
    const saveRun = run;
    const controller = new AbortController();
    saving = controller;
    // Saving also switches the app to reflection mode, so kiosks never need
    // the dashboard to get there. Leaving during the save skips the steps
    // that haven't started, so the restore on stop wins.
    deps.projection.saveCalibration(profile, controller.signal).then(
      (completed) => {
        if (!completed || saveRun !== run) return;
        saving = null;
        saved = true;
        deps.rt.log.info('calibrate: profile saved', { ...profile });
        deps.finish({ ok: true });
      },
      (err: unknown) => {
        if (saveRun !== run) return;
        deps.rt.log.warn('calibrate: profile save failed', { err: String(err) });
        message = 'save failed, try again';
        phase = 'verify';
      },
    );
  }

  function leave(): void {
    // Drop captures and solves still in flight.
    run += 1;
    phase = 'leaving';
    message = '';
    deps.finish(CALIBRATION_CANCELLED);
  }

  // -- rendering --------------------------------------------------------------

  return {
    start(): void {
      reset();
      saved = false;
      targetShownAt = performance.now();
      clearSamples();
      deps.projection.snapshot().catch((err: unknown) => {
        deps.rt.log.warn('calibrate: reading the mirror settings failed', { err: String(err) });
      });
    },

    render({ ctx, timestamp, deltaMs }): void {
      const cursor = cursorPicker.pick(deps.feed.mirror.data, timestamp);
      switch (phase) {
        case 'intro':
          renderIntro(ctx, timestamp);
          break;
        case 'capture':
          renderCapture(ctx, timestamp);
          break;
        case 'stepback':
          renderStepback(ctx, timestamp);
          break;
        case 'solving':
          drawCentered(ctx, ['Computing calibration…'], 700);
          break;
        case 'verify':
          renderVerify(ctx, cursor, deltaMs);
          break;
        case 'saving':
          drawCentered(ctx, ['Saving…'], 700);
          break;
        case 'failed':
          renderFailed(ctx, timestamp);
          break;
        case 'leaving':
          drawCentered(ctx, ['Leaving the calibration…'], 700);
          break;
      }
      if (phase !== 'saving' && phase !== 'leaving') renderBack(ctx, cursor, deltaMs);
      if (message) {
        drawText(ctx, message, REF_WIDTH / 2, REF_HEIGHT - 120, 30, ORANGE, 'center', 'middle');
      }
    },

    stop(): void {
      const abandoned = !saved;
      reset();
      if (abandoned) {
        clearSamples();
        deps.projection.restore().catch((err: unknown) => {
          deps.rt.log.warn('calibrate: restoring the projection failed', { err: String(err) });
        });
      }
    },
  };

  function renderBack(ctx: CanvasRenderingContext2D, cursor: Point | null, deltaMs: number): void {
    backDwellMs = stepDwell(backDwellMs, inRect(cursor, BACK_BUTTON), deltaMs);
    drawHoverButton(ctx, BACK_BUTTON, 'Back', backDwellMs / BACK_DWELL_MS, {
      color: DIM,
      lineWidth: 4,
      radius: 18,
      fontPx: 40,
    });
    if (backDwellMs >= BACK_DWELL_MS) leave();
  }

  function renderIntro(ctx: CanvasRenderingContext2D, now: number): void {
    drawCentered(
      ctx,
      [
        'Mirror calibration',
        '',
        'Stand one big step away from the mirror,',
        'facing it, with your whole body visible.',
        '',
        'Dots will appear one by one.',
        'Point at each with the index finger of ONE hand',
        '(either hand is fine, use the same one throughout):',
        'line up your finger’s REFLECTION with the dot,',
        'then hold still until the ring around it fills.',
      ],
      420,
    );
    // Never advance before people had time to read, regardless of tracking.
    const readProgress = Math.min(1, (now - phaseStartedAt) / INTRO_MIN_MS);
    if (bodyPresent(now)) {
      if (introStableSince === 0) introStableSince = now;
      const stableProgress = Math.min(1, (now - introStableSince) / INTRO_STABLE_MS);
      const progress = Math.min(readProgress, stableProgress);
      drawText(
        ctx,
        progress >= 1 ? 'Here we go!' : 'Starting soon — read the steps above',
        REF_WIDTH / 2,
        1400,
        34,
        GREEN,
        'center',
        'middle',
      );
      drawProgressRing(ctx, REF_WIDTH / 2, 1520, 40, progress, RING_GREEN);
      if (progress >= 1) {
        phase = 'capture';
        targetIdx = 0;
        round = 1;
        showTarget(now);
      }
    } else {
      introStableSince = 0;
      drawText(ctx, 'Waiting for you…', REF_WIDTH / 2, 1400, 34, DIM, 'center', 'middle');
    }
  }

  function renderCapture(ctx: CanvasRenderingContext2D, now: number): void {
    const target = targets()[targetIdx];
    if (!target) return;
    const [tx, ty] = target;

    drawText(
      ctx,
      'Point at the dot with your index finger:',
      REF_WIDTH / 2,
      300,
      32,
      DIM,
      'center',
      'middle',
    );
    drawText(
      ctx,
      'your finger’s reflection on the dot — then hold still',
      REF_WIDTH / 2,
      345,
      32,
      DIM,
      'center',
      'middle',
    );
    drawText(
      ctx,
      `dot ${capturedCount() + 1} of ${totalTargets()}`,
      REF_WIDTH / 2,
      REF_HEIGHT - 60,
      32,
      DIM,
      'center',
      'middle',
    );

    const progress = pending ? 1 : updateHold(now);
    // Dim while aiming: during the cooldown, or until the fingertip actually
    // moved toward the new dot (the hold is not armed yet).
    const aiming = now - targetShownAt < TARGET_COOLDOWN_MS || !holdArmed;

    // Target: pulsing outer ring + solid dot + progress arc. The aim window
    // renders dimmer so users see when holding starts to count.
    const pulse = 1 + 0.08 * Math.sin(now / 250);
    strokeCircle(ctx, tx, ty, 92 * pulse, 3, DIM);
    fillCircle(ctx, tx, ty, 26, pending ? GREEN : aiming ? 'rgba(255,129,0,0.45)' : ORANGE);
    drawProgressRing(ctx, tx, ty, 62, progress, RING_GREEN);

    if (!pending && progress >= 1) captureTarget(target);
  }

  function renderStepback(ctx: CanvasRenderingContext2D, now: number): void {
    drawCentered(
      ctx,
      [
        'Great — halfway there!',
        '',
        'Now take one big step BACK',
        'and face the mirror again.',
        '',
        'Three more dots follow from this distance.',
      ],
      540,
    );
    const minTimePassed = now - stepbackSince > STEPBACK_MIN_MS;
    const baseline = median(round1Spans);
    const span = shoulderSpan();
    const moved =
      baseline !== null &&
      span !== null &&
      Math.abs(span - baseline) / baseline > STEPBACK_SPAN_CHANGE;
    const waitedLong = now - stepbackSince > 12_000;

    if (minTimePassed && (moved || waitedLong) && bodyPresent(now)) {
      if (stepbackStableSince === 0) stepbackStableSince = now;
      const progress = Math.min(1, (now - stepbackStableSince) / STEPBACK_STABLE_MS);
      drawProgressRing(ctx, REF_WIDTH / 2, 1400, 40, progress, RING_GREEN);
      if (progress >= 1) {
        phase = 'capture';
        round = 2;
        targetIdx = 0;
        showTarget(now);
      }
    } else {
      stepbackStableSince = 0;
    }
  }

  function renderFailed(ctx: CanvasRenderingContext2D, now: number): void {
    drawCentered(
      ctx,
      [
        'Calibration failed',
        '',
        failReason || 'The samples could not be fitted.',
        '',
        'Tips: keep your whole body in view, hold each dot',
        'steadily, and use the same hand for every dot.',
        '',
        'Restarting…',
      ],
      560,
    );
    const progress = Math.min(1, (now - phaseStartedAt) / FAIL_SHOW_MS);
    drawProgressRing(ctx, REF_WIDTH / 2, 1500, 40, progress, { color: ORANGE, lineWidth: 8 });
    if (progress >= 1) reset();
  }

  function renderVerify(
    ctx: CanvasRenderingContext2D,
    cursor: Point | null,
    deltaMs: number,
  ): void {
    // The fitted projection is applied live: this skeleton should sit on the
    // user's reflection.
    drawBody(ctx, deps.feed.mirror.data.body_pose, {
      color: GREEN,
      weight: 5,
      minVisibility: 0.5,
      showHead: true,
    });

    drawCentered(ctx, ['Does the green skeleton', 'match your reflection?'], 380);
    if (fit?.residual_px_mean !== undefined) {
      drawText(
        ctx,
        `fit error: ${fit.residual_px_mean}px mean` +
          (fit.residual_px_max !== undefined ? ` / ${fit.residual_px_max}px max` : ''),
        REF_WIDTH / 2,
        560,
        26,
        DIM,
        'center',
        'middle',
      );
    }

    saveDwellMs = stepDwell(saveDwellMs, inRect(cursor, SAVE_BUTTON), deltaMs);
    redoDwellMs = stepDwell(redoDwellMs, inRect(cursor, REDO_BUTTON), deltaMs);
    const buttonStyle = { lineWidth: 4, radius: 18, fontPx: 44 };
    drawHoverButton(ctx, SAVE_BUTTON, 'Save', saveDwellMs / VERIFY_DWELL_MS, {
      ...buttonStyle,
      color: GREEN,
    });
    drawHoverButton(ctx, REDO_BUTTON, 'Redo', redoDwellMs / VERIFY_DWELL_MS, {
      ...buttonStyle,
      color: ORANGE,
    });
    if (cursor) fillCircle(ctx, cursor.x, cursor.y, 22, 'rgba(255,255,255,0.8)');

    if (saveDwellMs >= VERIFY_DWELL_MS) {
      saveDwellMs = 0;
      saveAndFinish();
    } else if (redoDwellMs >= VERIFY_DWELL_MS) {
      redoDwellMs = 0;
      restartRun();
    }
  }
}

// ---------------------------------------------------------------------------

function drawCentered(ctx: CanvasRenderingContext2D, lines: string[], topY: number): void {
  let y = topY;
  for (const [i, line] of lines.entries()) {
    const size = i === 0 && lines.length > 1 ? 52 : 34;
    if (line) {
      drawText(ctx, line, REF_WIDTH / 2, y, size, i === 0 ? '#ffffff' : DIM, 'center', 'middle');
    }
    y += size + 18;
  }
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}
