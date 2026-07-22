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
 * The wizard runs exclusively (menu stays on) and restores the persistent
 * overlays when it finishes.
 */

import { drawText, fillCircle, strokeCircle } from '../shared/canvas.js';
import { saveConfig, saveMirrorProfile, type MirrorProfile } from '../shared/config.js';
import type { LayerDeps } from '../shared/deps.js';
import { drawBody, isValid } from '../shared/mirror.js';
import { REF_HEIGHT, REF_WIDTH, type FrameContext, type Layer } from '../shared/types.js';

// Body-pose index fingertips (MediaPipe indices).
const LEFT_INDEX = 19;
const RIGHT_INDEX = 20;

// Capture tuning.
const HOLD_MS = 1200;
const TARGET_COOLDOWN_MS = 700;
const STILLNESS_FRAC = 0.018; // max deviation from the window mean, in frame diagonals.
const MIN_FINGER_VIS = 0.4;
const RAW_FRESH_MS = 500;
const INTRO_STABLE_MS = 2000;
const STEPBACK_SPAN_CHANGE = 0.12; // fractional shoulder-span change that counts as "moved".
const STEPBACK_STABLE_MS = 1000;
const VERIFY_DWELL_MS = 1400;
const CURSOR_GRACE_MS = 300;

// Targets in reference space, avoiding the menu button at (540, 130).
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
const WHITE = '#ffffff';
const DIM = 'rgba(255,255,255,0.65)';

type Phase = 'intro' | 'capture' | 'stepback' | 'solving' | 'verify' | 'saving';

interface SolveResult {
  ok: boolean;
  error?: string;
  tilt_deg?: number;
  scale?: number;
  affine?: number[];
  residual_px_mean?: number;
  residual_px_max?: number;
  samples?: number;
}

export function createCalibrateLayer(deps: LayerDeps): Layer {
  let phase: Phase = 'intro';
  let round: 1 | 2 = 1;
  let targetIdx = 0;
  let targetShownAt = 0;
  let message = '';
  let pending = false;

  // Stability window over the raw fingertip: [x, y, timestamp].
  let holdWindow: Array<[number, number, number]> = [];
  let introStableSince = 0;
  // Shoulder span (raw px) medians per capture, used for step-back detection.
  let round1Spans: number[] = [];
  let stepbackSince = 0;
  let stepbackStableSince = 0;

  let fit: SolveResult | null = null;
  let saved = false;

  // Verify-screen dwell state.
  let cursorLast: { x: number; y: number } | null = null;
  let cursorLastTs = 0;
  const verifyDwell = new Map<string, number>();

  function reset(): void {
    phase = 'intro';
    round = 1;
    targetIdx = 0;
    targetShownAt = 0;
    message = '';
    pending = false;
    holdWindow = [];
    introStableSince = 0;
    round1Spans = [];
    stepbackSince = 0;
    stepbackStableSince = 0;
    fit = null;
    cursorLast = null;
    cursorLastTs = 0;
    verifyDwell.clear();
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

  /** Raw camera-space fingertip: the more visible of the body index tips. */
  function rawFingertip(): [number, number, number] | null {
    const body = deps.feed.raw.data.body_pose;
    const left = body[LEFT_INDEX];
    const right = body[RIGHT_INDEX];
    const lv = left?.[2] ?? 0;
    const rv = right?.[2] ?? 0;
    const best = rv >= lv ? right : left;
    const vis = Math.max(lv, rv);
    if (!best || vis < MIN_FINGER_VIS) return null;
    return [best[0]!, best[1]!, vis];
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

  /** Returns hold progress 0..1; manages the stability window. */
  function updateHold(now: number): number {
    if (!bodyPresent(now) || now - targetShownAt < TARGET_COOLDOWN_MS) {
      holdWindow = [];
      return 0;
    }
    const tip = rawFingertip();
    if (!tip) {
      holdWindow = [];
      return 0;
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
    void deps.rt.drivers
      .execute('pose_to_mirror', 'capture_calibration_sample', { target: [target[0], target[1]] })
      .then((res) => {
        const r = res as { ok?: boolean; error?: string };
        if (!r?.ok) {
          message = r?.error ?? 'capture failed, hold still and retry';
          return;
        }
        if (round === 1 && span !== null) round1Spans.push(span);
        advanceTarget();
      })
      .catch((err) => {
        message = 'capture failed, retrying';
        deps.rt.log.warn('calibrate: capture failed', { err: String(err) });
      })
      .finally(() => {
        pending = false;
        holdWindow = [];
      });
  }

  function advanceTarget(): void {
    targetIdx += 1;
    targetShownAt = performance.now();
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

  // No `pending` guard here: solve() is invoked exactly once (from
  // advanceTarget, while the capture promise that called it is still marked
  // pending) and re-entry is prevented by the 'solving' phase itself.
  function solve(): void {
    void deps.rt.drivers
      .execute('pose_to_mirror', 'solve_calibration', {})
      .then(async (res) => {
        const r = res as SolveResult;
        if (!r?.ok) {
          message = r?.error ?? 'calibration failed';
          restartRun();
          return;
        }
        // The verify overlay must show the *fitted reflection* projection,
        // even when the wizard was launched from direct mode.
        await deps.rt.drivers
          .execute('pose_to_mirror', 'set_mirror_config', { mode: 'reflection' })
          .catch(() => undefined);
        fit = r;
        phase = 'verify';
        verifyDwell.clear();
      })
      .catch((err) => {
        deps.rt.log.warn('calibrate: solve failed', { err: String(err) });
        message = 'calibration failed, restarting';
        restartRun();
      });
  }

  function restartRun(): void {
    void deps.rt.drivers
      .execute('pose_to_mirror', 'clear_calibration_samples', {})
      .catch(() => undefined);
    const keep = message;
    reset();
    message = keep;
  }

  function saveAndFinish(): void {
    if (!fit || phase === 'saving') return;
    phase = 'saving';
    const profile: MirrorProfile = {
      tilt_deg: fit.tilt_deg!,
      scale: fit.scale!,
      affine: fit.affine as [number, number, number, number],
      ...(typeof fit.residual_px_mean === 'number'
        ? { residual_px_mean: fit.residual_px_mean }
        : {}),
      updatedAt: Date.now(),
    };
    void (async () => {
      await saveMirrorProfile(deps.rt, profile);
      // Calibrating implies a physical mirror rig: switch (and persist) the
      // projection mode so kiosks never need the dashboard to get there.
      if (deps.config.projection.mode !== 'reflection') {
        deps.config.projection.mode = 'reflection';
        await saveConfig(deps.rt, deps.config);
      }
      saved = true;
      deps.rt.log.info('calibrate: profile saved', { ...profile });
      finish();
    })().catch((err) => {
      deps.rt.log.warn('calibrate: profile save failed', { err: String(err) });
      message = 'save failed, try again';
      phase = 'verify';
    });
  }

  function finish(): void {
    // Restore the persistent overlays, then stop ourselves.
    for (const slug of ['hands', 'body', 'face']) deps.controller.start(slug);
    deps.controller.stop('calibrate');
  }

  // -- verify-screen dwell cursor (mirror space; projection now calibrated) ---

  function mirrorCursor(now: number): { x: number; y: number } | null {
    const m = deps.feed.mirror.data;
    const candidates = [
      m.right_hand_pose[8],
      m.left_hand_pose[8],
      m.body_pose[RIGHT_INDEX],
      m.body_pose[LEFT_INDEX],
    ];
    for (const c of candidates) {
      if (isValid(c)) {
        cursorLast = { x: c[0]!, y: c[1]! };
        cursorLastTs = now;
        return cursorLast;
      }
    }
    if (cursorLast && now - cursorLastTs < CURSOR_GRACE_MS) return cursorLast;
    return null;
  }

  // -- rendering --------------------------------------------------------------

  return {
    start(): void {
      reset();
      saved = false;
      targetShownAt = performance.now();
      void deps.rt.drivers
        .execute('pose_to_mirror', 'clear_calibration_samples', {})
        .catch(() => undefined);
    },

    render(frame: FrameContext): void {
      const { ctx, timestamp, deltaMs } = frame;
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
          renderVerify(ctx, timestamp, deltaMs);
          break;
        case 'saving':
          drawCentered(ctx, ['Saving…'], 700);
          break;
      }
      if (message) {
        drawText(ctx, message, REF_WIDTH / 2, REF_HEIGHT - 120, 30, ORANGE, 'center', 'middle');
      }
    },

    stop(): void {
      // Abandoned from direct mode without saving: put the driver back so the
      // regular experiences keep working with the direct overlay.
      if (!saved && deps.config.projection.mode === 'direct') {
        void deps.rt.drivers
          .execute('pose_to_mirror', 'set_mirror_config', { mode: 'direct' })
          .catch(() => undefined);
      }
      reset();
    },
  };

  function renderIntro(ctx: CanvasRenderingContext2D, now: number): void {
    drawCentered(
      ctx,
      [
        'Mirror calibration',
        '',
        'Stand one big step away from the mirror,',
        'facing it, with your whole body visible.',
        '',
        'You will point at dots with your index finger:',
        'line up your finger’s reflection with each dot',
        'and hold still until the ring fills.',
      ],
      480,
    );
    if (bodyPresent(now)) {
      if (introStableSince === 0) introStableSince = now;
      const progress = Math.min(1, (now - introStableSince) / INTRO_STABLE_MS);
      drawText(ctx, 'Ready…', REF_WIDTH / 2, 1400, 34, GREEN, 'center', 'middle');
      drawProgressRing(ctx, REF_WIDTH / 2, 1520, 40, progress, GREEN);
      if (progress >= 1) {
        phase = 'capture';
        targetIdx = 0;
        round = 1;
        targetShownAt = now;
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
      'Align your fingertip’s reflection with the dot and hold still',
      REF_WIDTH / 2,
      330,
      30,
      DIM,
      'center',
      'middle',
    );
    drawText(
      ctx,
      `${capturedCount() + 1} / ${totalTargets()}`,
      REF_WIDTH / 2,
      REF_HEIGHT - 60,
      32,
      DIM,
      'center',
      'middle',
    );

    const progress = pending ? 1 : updateHold(now);

    // Target: pulsing outer ring + solid dot + progress arc.
    const pulse = 1 + 0.08 * Math.sin(now / 250);
    strokeCircle(ctx, tx, ty, 92 * pulse, 3, DIM);
    fillCircle(ctx, tx, ty, 26, pending ? GREEN : ORANGE);
    drawProgressRing(ctx, tx, ty, 62, progress, GREEN);

    if (!pending && progress >= 1) captureTarget(target);
  }

  function renderStepback(ctx: CanvasRenderingContext2D, now: number): void {
    drawCentered(
      ctx,
      ['Great!', '', 'Now take one big step back', 'and face the mirror again.'],
      600,
    );
    const baseline = median(round1Spans);
    const span = shoulderSpan();
    const moved =
      baseline !== null &&
      span !== null &&
      Math.abs(span - baseline) / baseline > STEPBACK_SPAN_CHANGE;
    const waitedLong = now - stepbackSince > 10_000;

    if ((moved || waitedLong) && bodyPresent(now)) {
      if (stepbackStableSince === 0) stepbackStableSince = now;
      const progress = Math.min(1, (now - stepbackStableSince) / STEPBACK_STABLE_MS);
      drawProgressRing(ctx, REF_WIDTH / 2, 1400, 40, progress, GREEN);
      if (progress >= 1) {
        phase = 'capture';
        round = 2;
        targetIdx = 0;
        targetShownAt = now;
      }
    } else {
      stepbackStableSince = 0;
    }
  }

  function renderVerify(ctx: CanvasRenderingContext2D, now: number, deltaMs: number): void {
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

    const cursor = mirrorCursor(now);
    drawDwellButton(ctx, 'save', 'Save', 150, 1580, 340, 130, GREEN, cursor, deltaMs, () =>
      saveAndFinish(),
    );
    drawDwellButton(ctx, 'redo', 'Redo', 590, 1580, 340, 130, ORANGE, cursor, deltaMs, () => {
      restartRun();
    });

    if (cursor) fillCircle(ctx, cursor.x, cursor.y, 22, 'rgba(255,255,255,0.8)');
  }

  function drawDwellButton(
    ctx: CanvasRenderingContext2D,
    id: string,
    label: string,
    x: number,
    y: number,
    w: number,
    h: number,
    color: string,
    cursor: { x: number; y: number } | null,
    deltaMs: number,
    fire: () => void,
  ): void {
    const hovered =
      cursor !== null && cursor.x > x && cursor.x < x + w && cursor.y > y && cursor.y < y + h;
    let ms = verifyDwell.get(id) ?? 0;
    ms = hovered ? ms + deltaMs : Math.max(0, ms - deltaMs * 2);
    verifyDwell.set(id, ms);
    const progress = Math.min(1, ms / VERIFY_DWELL_MS);

    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    ctx.strokeStyle = color;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 18);
    ctx.fill();
    ctx.stroke();
    if (progress > 0) {
      ctx.fillStyle = `${color}59`; // ~35% alpha.
      ctx.beginPath();
      ctx.roundRect(x, y, w * progress, h, 18);
      ctx.fill();
    }
    drawText(ctx, label, x + w / 2, y + h / 2, 44, WHITE, 'center', 'middle');

    if (progress >= 1) {
      verifyDwell.set(id, 0);
      fire();
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

function drawProgressRing(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  progress: number,
  color: string,
): void {
  if (progress <= 0) return;
  ctx.strokeStyle = color;
  ctx.lineWidth = 8;
  ctx.beginPath();
  ctx.arc(x, y, r, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2);
  ctx.stroke();
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}
