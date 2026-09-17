/**
 * Sign Training: a guided sign-language tutor.
 *
 * For each target sign it:
 *   1. plays a reference video of the sign for the user to copy;
 *   2. waits until the `slr` driver recognises that sign for several outputs
 *      in a row;
 *   3. runs a correction overlay: a recorded reference skeleton (from
 *      `slr_samples/<sign>/<frame>.json`), fitted to the user's body by nose
 *      and hip, that only advances while the user's pose matches it.
 *
 * The recognised sentence and the current target show as HUD text.
 */

import { fitNoseHip, type NoseHipFit, type Point2 } from '../shared/align.js';
import type { LayerDeps } from '../shared/deps.js';
import { drawText, fillRect, strokeRect } from '../shared/draw.js';
import { createMediaCache } from '../shared/media.js';
import { drawBody, drawHand } from '../shared/mirror.js';
import { PERFORMABLE_SIGNS, SignTracker } from '../shared/sign.js';
import { REF_HEIGHT, REF_WIDTH, type Landmark, type Layer } from '../shared/types.js';
import { dist } from '../shared/ui.js';

const SAMPLE_FRAMES = 30;
/**
 * How long a matched pose shows each sample frame: the legacy loop stepped one
 * frame per 60 fps render, so the 30 frames replay in half a second.
 */
const SAMPLE_FRAME_MS = 1000 / 60;
const BODY_STUDY = [0, 11, 12, 15, 16, 23, 24];
const HAND_STUDY = [0, 5, 17, 4, 8, 20];
const BODY_PRECISION = 40;
const HAND_PRECISION = 40;
const PROBABILITY_THRESHOLD = 0.9;
const REPLAY_MS = 15000;
const CORRECTION_IDLE_MS = 15000;
const MAX_SENTENCE = 5;
const NOSE = 0;
const HIP = 24;
/**
 * Signs with their own recording in `sign-training/videos/`. Every other
 * reference video is Aria's sign animation in `signs/Aria/`, shared with sign-game.
 */
const TRAINING_VIDEOS: ReadonlySet<string> = new Set(['hello', 'left', 'ok', 'right']);

interface SampleFrame {
  readonly body: readonly Point2[];
  readonly right_hand: readonly Point2[];
  readonly left_hand: readonly Point2[];
}

type Phase = 'mimic' | 'correction' | 'done';

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

  const target = (): string => PERFORMABLE_SIGNS[targetIdx] ?? '';
  const frameIdx = (): number => Math.floor(framePosition);

  function videoUrl(sign: string): string {
    const file = `${sign.replace(/ /g, '_')}.webm`;
    return deps.asset(
      TRAINING_VIDEOS.has(sign) ? `sign-training/videos/${file}` : `signs/Aria/${file}`,
    );
  }

  function startMimic(now: number): void {
    phase = 'mimic';
    // A hold of the previous target must not count toward this one.
    tracker.reset();
    lastReplay = now;
    // The previous target's video stops with the next pauseUnused().
    video = media.video(videoUrl(target()));
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

  function updateMimic(now: number, freshGuess: boolean): void {
    if (video && now - lastReplay > REPLAY_MS) {
      lastReplay = now;
      video.currentTime = 0;
    }
    // Holds count recognizer outputs, not render frames.
    if (!freshGuess) return;
    if (tracker.probability > PROBABILITY_THRESHOLD && tracker.performing()) {
      if (sentence.at(-1) !== tracker.sign) sentence.push(tracker.sign);
      if (sentence.length > MAX_SENTENCE) sentence.shift();
    }
    if (tracker.held(target())) enterCorrection(now);
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

    const frame = sampleFrames[frameIdx()]!;
    const bodyDiff = meanDistance(fit, frame.body, mirror.body_pose, BODY_STUDY);
    const rightDiff = handDiff(fit, frame.right_hand, mirror.right_hand_pose);
    const leftDiff = handDiff(fit, frame.left_hand, mirror.left_hand_pose);
    if (bodyDiff < BODY_PRECISION && rightDiff < HAND_PRECISION && leftDiff < HAND_PRECISION) {
      framePosition = advanceSamplePosition(framePosition, deltaMs);
      lastDetected = now;
    }
  }

  function transform(points: readonly Point2[], f: NoseHipFit): Landmark[] {
    return points.map(([x, y]) => [f.offsetX + x * f.ratio, f.offsetY + y * f.ratio]);
  }

  return {
    start(): void {
      targetIdx = 0;
      sentence.length = 0;
      sampleFrames = [];
      samplesLoading = false;
      startMimic(performance.now());
    },

    render({ ctx, timestamp, deltaMs }): void {
      const freshGuess = tracker.update(deps.feed);

      if (phase === 'mimic') updateMimic(timestamp, freshGuess);
      else if (phase === 'correction') updateCorrection(timestamp, deltaMs);

      if (phase === 'mimic' && video && media.playing(video)) {
        const vw = 600;
        const vh = (video.videoHeight / video.videoWidth) * vw || 380;
        ctx.drawImage(video, REF_WIDTH / 2 - vw / 2, 60, vw, vh);
        strokeRect(ctx, REF_WIDTH / 2 - vw / 2, 60, vw, vh, 4, '#ffffff');
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
          const frame = sampleFrames[frameIdx()]!;
          drawBody(ctx, transform(frame.body, fit), {
            color: '#32fAff',
            weight: 8,
            minVisibility: 0,
            showHead: true,
            showWrist: true,
          });
          drawHand(ctx, transform(frame.right_hand, fit), { color: '#32fAff', weight: 6 });
          drawHand(ctx, transform(frame.left_hand, fit), { color: '#32fAff', weight: 6 });
          drawText(
            ctx,
            'Follow the model with your hands and body',
            REF_WIDTH / 2,
            REF_HEIGHT - 80,
            36,
            'rgba(255,255,255,0.85)',
            'center',
            'middle',
          );
          fillRect(
            ctx,
            0,
            REF_HEIGHT - 40,
            REF_WIDTH * (framePosition / SAMPLE_FRAMES),
            12,
            '#32fAff',
          );
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
