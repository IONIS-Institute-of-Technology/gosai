/**
 * Sign Training: a guided sign-language tutor.
 *
 * For each target sign it:
 *   1. plays a reference video of the sign for the user to copy;
 *   2. waits until the `slr` driver recognises that sign and the user holds
 *      it steady;
 *   3. runs a correction overlay: a recorded reference skeleton (from
 *      `slr_samples/<sign>/<frame>.json`), fitted to the user's body by nose
 *      and hip, that only advances while the user's pose matches it.
 *
 * The correction shows its working. Each studied joint is marked on the
 * reference, green where the user is on it and amber with a line from where
 * they actually are otherwise, and a bar per part (body, each hand) says which
 * one is still holding them up. Without that the step was a skeleton that sat
 * there: several of the recorded references barely move across their 30 frames
 * (the first target, "ok", travels 16 px), so nothing on screen told the user
 * whether they were close, whether it was working, or what to change.
 *
 * The recognised sentence and the current target show as HUD text.
 */

import { fitNoseHip, type NoseHipFit, type Point2 } from '../shared/align.js';
import type { LayerDeps } from '../shared/deps.js';
import {
  drawContain,
  drawText,
  fillCircle,
  fillRect,
  strokeLine,
  strokeRect,
} from '../shared/draw.js';
import { createMediaCache } from '../shared/media.js';
import { drawBody, drawHand, isValid } from '../shared/mirror.js';
import { PERFORMABLE_SIGNS, SignTracker } from '../shared/sign.js';
import { REF_HEIGHT, REF_WIDTH, type Landmark, type Layer } from '../shared/types.js';
import { dist, type Rect } from '../shared/ui.js';

const SAMPLE_FRAMES = 30;
/**
 * How long a matched pose shows each sample frame: the legacy loop stepped one
 * frame per 60 fps render, so the 30 frames replay in half a second.
 */
const SAMPLE_FRAME_MS = 1000 / 60;
/**
 * The reference video fits in this box. It sits right of the menu button
 * (x 460 to 620), which would otherwise cover Aria's face and raised hands,
 * and ends about where the old 600 px wide 16:9 video did, so it covers no
 * more of the reflection.
 */
const VIDEO_BOX: Rect = { x: 650, y: 60, w: 390, h: 340 };
const BODY_STUDY = [0, 11, 12, 15, 16, 23, 24];
const HAND_STUDY = [0, 5, 17, 4, 8, 20];
/**
 * How close a joint has to be, as a fraction of the reference pose's own
 * nose-to-hip distance. The samples were recorded at different distances from
 * the camera (their scales run from 282 to 377 px), so the absolute pixel
 * tolerance this used to carry made some signs noticeably stricter than
 * others.
 */
const BODY_TOLERANCE = 0.13;
const HAND_TOLERANCE = 0.13;
/** Where the correction's feedback sits, clear of the guide's hint pill. */
const METER_Y = 1520;
const METER_W = 290;
const METER_GAP = 25;
const PROMPT_Y = 1700;
const HOLD_Y = 1760;
const PROBABILITY_THRESHOLD = 0.9;
const REPLAY_MS = 15000;
const CORRECTION_IDLE_MS = 15000;
const MAX_SENTENCE = 5;
const NOSE = 0;
const HIP = 24;

interface SampleFrame {
  readonly body: readonly Point2[];
  readonly right_hand: readonly Point2[];
  readonly left_hand: readonly Point2[];
}

type Phase = 'mimic' | 'correction' | 'done';

/** One part of the correction, how far off it is and whether it is being asked for. */
interface Part {
  readonly label: string;
  /** Mean distance from the reference, in sample pixels. */
  readonly diff: number;
  readonly tolerance: number;
  /** False when the reference pose doesn't use this hand, so it can't block. */
  readonly used: boolean;
}

/** True when a recorded hand is present: absent ones are stored as all zeros. */
export function handInFrame(points: readonly Point2[]): boolean {
  const origin = points[0];
  return !!origin && (origin[0] !== 0 || origin[1] !== 0);
}

/** The reference pose's nose-to-hip distance, which every tolerance is relative to. */
export function poseScale(frame: { readonly body: readonly Point2[] }): number {
  const nose = frame.body[NOSE];
  const hip = frame.body[HIP];
  if (!nose || !hip) return 0;
  return Math.hypot(nose[0] - hip[0], nose[1] - hip[1]);
}

/**
 * How full a part's bar is, 0 to 1. It reaches 1 exactly when the part is
 * inside its tolerance, and falls away as the user gets further out, so the
 * bar is something to aim at rather than a pass/fail lamp.
 */
export function closeness(part: Part): number {
  if (!part.used || part.diff <= part.tolerance) return 1;
  if (!Number.isFinite(part.diff)) return 0;
  return Math.max(0, 2 - part.diff / part.tolerance);
}

/** The reference video of a sign: Aria's animation, shared with sign-game. */
export function signVideoPath(sign: string): string {
  return `signs/Aria/${sign.replace(/ /g, '_')}.webm`;
}

/** Fits a sample skeleton onto the user's body, or null while nose and hip can't give a scale. */
export function fitSample(body: readonly Landmark[], sample: SampleFrame): NoseHipFit | null {
  const nose = body[NOSE];
  const hip = body[HIP];
  const sampleNose = sample.body[NOSE];
  const sampleHip = sample.body[HIP];
  if (!nose || !hip || !sampleNose || !sampleHip) return null;
  return fitNoseHip([nose[0]!, nose[1]!], [hip[0]!, hip[1]!], sampleNose, sampleHip);
}

/**
 * Mean distance between the fitted sample points and the user's, in sample
 * pixels. Infinity when no studied point exists on both sides.
 */
export function meanDistance(
  fit: NoseHipFit,
  samplePoints: readonly Point2[],
  userPoints: readonly Landmark[],
  indices: readonly number[],
): number {
  let sum = 0;
  let count = 0;
  for (const i of indices) {
    const s = samplePoints[i];
    const u = userPoints[i];
    if (!s || !u) continue;
    sum += dist(fit.offsetX + s[0] * fit.ratio, fit.offsetY + s[1] * fit.ratio, u[0]!, u[1]!);
    count++;
  }
  return count > 0 ? sum / (count * fit.ratio) : Number.POSITIVE_INFINITY;
}

/**
 * Progress through the sample frames after `deltaMs` of matching. It never
 * moves past the next frame, so a long frame can't skip a pose the user
 * hasn't matched.
 */
export function advanceSamplePosition(position: number, deltaMs: number): number {
  return Math.min(Math.floor(position) + 1, position + deltaMs / SAMPLE_FRAME_MS);
}

export function createSignTrainingLayer(deps: LayerDeps): Layer {
  const tracker = new SignTracker();
  const media = createMediaCache();

  let targetIdx = 0;
  let phase: Phase = 'mimic';
  let lastReplay = 0;
  const sentence: string[] = [];
  let video: HTMLVideoElement | null = null;

  // Correction state.
  let sampleFrames: SampleFrame[] = [];
  let samplesLoading = false;
  /** Bumped by every sample load and stop, so a load that lost the race is dropped. */
  let loads = 0;
  /** Progress through the sample frames, in frames. */
  let framePosition = 0;
  let fit: NoseHipFit | null = null;
  let lastDetected = 0;
  /** The reference pose's nose-to-hip distance: every tolerance is relative to it. */
  let sampleScale = 1;

  const target = (): string => PERFORMABLE_SIGNS[targetIdx] ?? '';
  const frameIdx = (): number => Math.floor(framePosition);

  function startMimic(now: number): void {
    phase = 'mimic';
    // Only the target counts: the recogniser wandering onto another sign is
    // noise, not an argument against the one being copied.
    tracker.reset();
    tracker.setCandidates([target()]);
    lastReplay = now;
    // The previous target's video stops with the next pauseUnused().
    video = media.video(deps.asset(signVideoPath(target())));
    video.currentTime = 0;
  }

  async function loadSamples(sign: string): Promise<void> {
    const loadRun = ++loads;
    samplesLoading = true;
    try {
      const frames = await Promise.all(
        Array.from({ length: SAMPLE_FRAMES }, async (_, i) => {
          const url = deps.asset(`sign-training/slr_samples/${sign}/${i}.json`);
          const resp = await fetch(url, { signal: deps.rt.signal });
          if (!resp.ok) throw new Error(`${url}: HTTP ${resp.status}`);
          return parseSampleFrame(await resp.json());
        }),
      );
      if (loadRun === loads) {
        sampleFrames = frames;
        sampleScale = poseScale(frames[0]!) || 1;
        lastDetected = performance.now();
      }
    } catch (err) {
      if (loadRun === loads) {
        deps.rt.log.warn('sign-training: sample load failed', { sign, err: String(err) });
      }
    } finally {
      if (loadRun === loads) samplesLoading = false;
    }
  }

  function enterCorrection(now: number): void {
    phase = 'correction';
    tracker.consume();
    framePosition = 0;
    fit = null;
    sampleFrames = [];
    lastDetected = now;
    video = null;
    void loadSamples(target());
  }

  function nextTarget(now: number): void {
    targetIdx++;
    if (targetIdx >= PERFORMABLE_SIGNS.length) {
      phase = 'done';
      video = null;
      return;
    }
    startMimic(now);
  }

  /**
   * The bar under the reference clip: how much evidence the target sign has
   * gathered, or the reason none is being gathered yet.
   */
  function drawTargetProgress(ctx: CanvasRenderingContext2D): void {
    const { x, y, w, h } = VIDEO_BOX;
    if (!tracker.armed()) {
      drawText(
        ctx,
        'hands down to start',
        x + w / 2,
        y + h + 30,
        26,
        '#ffb24d',
        'center',
        'middle',
      );
      return;
    }
    fillRect(ctx, x, y + h + 10, w, 10, 'rgba(255,255,255,0.2)');
    fillRect(ctx, x, y + h + 10, w * tracker.progressFor(target()), 10, '#32fAff');
  }

  function updateMimic(now: number, freshGuess: boolean): void {
    if (video && now - lastReplay > REPLAY_MS) {
      lastReplay = now;
      video.currentTime = 0;
    }
    // The recognised sentence is built per guess; the hold that moves on to
    // the correction is wall-clock time, so it is checked every frame.
    if (freshGuess && tracker.probability > PROBABILITY_THRESHOLD && tracker.performing()) {
      if (sentence.at(-1) !== tracker.sign) sentence.push(tracker.sign);
      if (sentence.length > MAX_SENTENCE) sentence.shift();
    }
    if (tracker.held(target())) enterCorrection(now);
  }

  /**
   * How far each part of the user is from the reference pose, in sample
   * pixels. Drawn as well as tested, so the user can see which part is
   * holding them up instead of guessing at a skeleton that never moves.
   */
  function correctionParts(): Part[] | null {
    if (!fit || frameIdx() >= sampleFrames.length) return null;
    const frame = sampleFrames[frameIdx()]!;
    const mirror = deps.feed.mirror.data;
    return [
      {
        label: 'body',
        diff: meanDistance(fit, frame.body, mirror.body_pose, BODY_STUDY),
        tolerance: sampleScale * BODY_TOLERANCE,
        used: true,
      },
      {
        label: 'right hand',
        diff: handDiff(fit, frame.right_hand, mirror.right_hand_pose),
        tolerance: sampleScale * HAND_TOLERANCE,
        used: handInFrame(frame.right_hand),
      },
      {
        label: 'left hand',
        diff: handDiff(fit, frame.left_hand, mirror.left_hand_pose),
        tolerance: sampleScale * HAND_TOLERANCE,
        used: handInFrame(frame.left_hand),
      },
    ];
  }

  function updateCorrection(now: number, deltaMs: number): void {
    if (sampleFrames.length < SAMPLE_FRAMES) return;
    if (frameIdx() >= SAMPLE_FRAMES) {
      nextTarget(now);
      return;
    }
    const mirror = deps.feed.mirror.data;
    if (mirror.body_pose.length <= HIP) return;

    if (now - lastDetected > CORRECTION_IDLE_MS) {
      // Give up on this sign and move on.
      nextTarget(now);
      return;
    }

    if (!fit) {
      // Keeps trying while the nose and hip coincide and give no scale.
      fit = fitSample(mirror.body_pose, sampleFrames[0]!);
      if (fit) lastDetected = now;
      return;
    }

    const parts = correctionParts();
    if (parts?.every((part) => part.diff < part.tolerance)) {
      framePosition = advanceSamplePosition(framePosition, deltaMs);
      lastDetected = now;
    }
  }

  function transform(points: readonly Point2[], f: NoseHipFit): Landmark[] {
    return points.map(([x, y]) => [f.offsetX + x * f.ratio, f.offsetY + y * f.ratio]);
  }

  return {
    async preload(): Promise<void> {
      // The first target's clip and the first frame of its correction stand
      // for the rest: the clips and samples ship together.
      const first = PERFORMABLE_SIGNS[0] ?? '';
      await deps.assets.require('sign-training', [
        signVideoPath(first),
        `sign-training/slr_samples/${first}/0.json`,
      ]);
    },

    start(): void {
      targetIdx = 0;
      sentence.length = 0;
      sampleFrames = [];
      samplesLoading = false;
      startMimic(performance.now());
    },

    render({ ctx, timestamp, deltaMs }): void {
      const freshGuess = tracker.update(deps.feed, deltaMs, timestamp);

      if (phase === 'mimic') updateMimic(timestamp, freshGuess);
      else if (phase === 'correction') updateCorrection(timestamp, deltaMs);

      if (phase === 'mimic' && video && media.playing(video)) {
        const drawn = drawContain(
          ctx,
          video,
          video.videoWidth,
          video.videoHeight,
          VIDEO_BOX.x + VIDEO_BOX.w / 2,
          VIDEO_BOX.y + VIDEO_BOX.h / 2,
          VIDEO_BOX.w,
          VIDEO_BOX.h,
        );
        if (drawn) strokeRect(ctx, drawn.x, drawn.y, drawn.w, drawn.h, 4, '#ffffff');
        drawTargetProgress(ctx);
      }
      media.pauseUnused();

      if (phase === 'correction') {
        if (samplesLoading || sampleFrames.length < SAMPLE_FRAMES) {
          drawText(
            ctx,
            'Loading reference...',
            REF_WIDTH / 2,
            REF_HEIGHT / 2,
            36,
            '#fff',
            'center',
            'middle',
          );
        } else if (fit && frameIdx() < SAMPLE_FRAMES) {
          drawCorrection(ctx, fit);
        }
      }

      if (phase === 'done') {
        drawText(ctx, 'Well done!', REF_WIDTH / 2, REF_HEIGHT / 2, 56, '#fff', 'center', 'middle');
        return;
      }

      drawHud(ctx);
    },

    suspend(): void {
      media.pauseAll();
    },

    stop(): void {
      loads += 1;
      video = null;
      media.release();
      tracker.reset();
    },
  };

  /**
   * The reference pose, what is still wrong with it, and how much of the hold
   * is done. Several of the recorded references barely move over their 30
   * frames (the first one, "ok", travels 16 px), so without this the screen is
   * a skeleton that sits there and gives no sign of whether you are close.
   */
  function drawCorrection(ctx: CanvasRenderingContext2D, f: NoseHipFit): void {
    const frame = sampleFrames[frameIdx()]!;
    drawBody(ctx, transform(frame.body, f), {
      color: '#32fAff',
      weight: 8,
      minVisibility: 0,
      showHead: true,
      showWrist: true,
    });
    drawHand(ctx, transform(frame.right_hand, f), { color: '#32fAff', weight: 6 });
    drawHand(ctx, transform(frame.left_hand, f), { color: '#32fAff', weight: 6 });

    const mirror = deps.feed.mirror.data;
    const bodyTolerance = sampleScale * BODY_TOLERANCE;
    const handTolerance = sampleScale * HAND_TOLERANCE;
    drawPulls(ctx, f, frame.body, mirror.body_pose, BODY_STUDY, bodyTolerance);
    if (handInFrame(frame.right_hand)) {
      drawPulls(ctx, f, frame.right_hand, mirror.right_hand_pose, HAND_STUDY, handTolerance);
    }
    if (handInFrame(frame.left_hand)) {
      drawPulls(ctx, f, frame.left_hand, mirror.left_hand_pose, HAND_STUDY, handTolerance);
    }

    const parts = correctionParts() ?? [];
    drawMeters(ctx, parts);
    drawText(
      ctx,
      parts.every((part) => part.diff < part.tolerance) ? 'Hold it' : 'Move onto the blue pose',
      REF_WIDTH / 2,
      PROMPT_Y,
      36,
      'rgba(255,255,255,0.9)',
      'center',
      'middle',
    );
    // A track, so an untouched hold reads as empty rather than as missing.
    fillRect(ctx, 90, HOLD_Y, REF_WIDTH - 180, 14, 'rgba(255,255,255,0.18)');
    fillRect(ctx, 90, HOLD_Y, (REF_WIDTH - 180) * (framePosition / SAMPLE_FRAMES), 14, '#32fAff');
  }

  /**
   * Marks each studied joint on the reference and, where the user isn't on it,
   * draws the line from where they are to where it wants them.
   */
  function drawPulls(
    ctx: CanvasRenderingContext2D,
    f: NoseHipFit,
    samplePoints: readonly Point2[],
    userPoints: readonly Landmark[],
    indices: readonly number[],
    tolerance: number,
  ): void {
    for (const i of indices) {
      const s = samplePoints[i];
      const u = userPoints[i];
      if (!s) continue;
      const x = f.offsetX + s[0] * f.ratio;
      const y = f.offsetY + s[1] * f.ratio;
      if (!isValid(u)) {
        fillCircle(ctx, x, y, 30, 'rgba(255,178,77,0.55)');
        continue;
      }
      if (dist(x, y, u[0]!, u[1]!) / f.ratio <= tolerance) {
        fillCircle(ctx, x, y, 34, '#5bff9d');
      } else {
        strokeLine(ctx, u[0]!, u[1]!, x, y, 6, 'rgba(255,178,77,0.75)');
        fillCircle(ctx, x, y, 34, '#ffb24d');
      }
    }
  }

  /** One bar per part, so the user can see which one is holding them up. */
  function drawMeters(ctx: CanvasRenderingContext2D, parts: readonly Part[]): void {
    const total = parts.length * METER_W + (parts.length - 1) * METER_GAP;
    let x = (REF_WIDTH - total) / 2;
    for (const part of parts) {
      const done = part.diff < part.tolerance;
      const color = !part.used ? 'rgba(255,255,255,0.25)' : done ? '#5bff9d' : '#ffb24d';
      fillRect(ctx, x, METER_Y, METER_W, 16, 'rgba(255,255,255,0.18)');
      fillRect(ctx, x, METER_Y, METER_W * closeness(part), 16, color);
      drawText(ctx, part.label, x + METER_W / 2, METER_Y + 46, 26, color, 'center', 'middle');
      x += METER_W + METER_GAP;
    }
  }

  function drawHud(ctx: CanvasRenderingContext2D): void {
    // Recognised sentence history.
    fillRect(ctx, 0, 0, 740, 48, 'rgb(30,70,160)');
    drawText(ctx, sentence.join(' '), 8, 34, 30, '#fff', 'left', 'alphabetic');

    // Current detection.
    fillRect(
      ctx,
      0,
      60,
      Math.min(740, tracker.probability * (tracker.sign.length || 1) * 22),
      44,
      'rgb(30,70,160)',
    );
    drawText(ctx, tracker.sign || 'empty', 8, 92, 30, '#fff', 'left', 'alphabetic');

    // Target sign.
    fillRect(ctx, 0, 120, 220, 44, 'rgb(240,0,0)');
    drawText(ctx, target(), 8, 152, 30, '#fff', 'left', 'alphabetic');
  }
}

/** Hands missing from the sample (a zero origin) aren't scored, nor are untracked user hands. */
function handDiff(
  fit: NoseHipFit,
  samplePoints: readonly Point2[],
  userPoints: readonly Landmark[],
): number {
  const origin = samplePoints[0];
  if (!origin || (origin[0] === 0 && origin[1] === 0) || userPoints.length === 0) return 0;
  return meanDistance(fit, samplePoints, userPoints, HAND_STUDY);
}

/**
 * Sample frame layout (flat number list): 33 body (x, y) pairs, then 21
 * right-hand pairs, then 21 left-hand pairs.
 */
function parseSampleFrame(flat: unknown): SampleFrame {
  const values = Array.isArray(flat) ? flat : [];
  const pairs = (start: number, count: number): Point2[] =>
    Array.from({ length: count }, (_, i) => [
      Number(values[start + i * 2] ?? 0),
      Number(values[start + i * 2 + 1] ?? 0),
    ]);
  return { body: pairs(0, 33), right_hand: pairs(66, 21), left_hand: pairs(108, 21) };
}
