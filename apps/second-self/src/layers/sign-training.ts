/**
 * Sign Training: a guided sign-language tutor.
 *
 * Ports the legacy `sign_training` app. For each target sign in the action
 * sequence it:
 *   1. plays a reference video of the sign (top of screen) for the user to copy;
 *   2. waits until the `slr` driver recognises the user performing that sign
 *      (held above a confidence threshold);
 *   3. runs a frame-by-frame **correction** overlay: a recorded reference
 *      skeleton (from `slr_samples/<sign>/<frame>.json`), aligned to the user's
 *      body via a nose<->hip scale/offset, that only advances when the user's
 *      live `mirrored_data` matches the reference pose closely.
 *
 * Recognised sentence history and the current target are shown as HUD text.
 */

import { drawText, fillRect, strokeRect } from '../shared/canvas.js';
import type { LayerDeps } from '../shared/deps.js';
import { ensureVideoPlaying, getVideo } from '../shared/media.js';
import { drawBody, drawHand } from '../shared/mirror.js';
import { SignTracker } from '../shared/sign.js';
import {
  REF_HEIGHT,
  REF_WIDTH,
  type FrameContext,
  type Landmark,
  type Layer,
} from '../shared/types.js';

const SAMPLE_FRAMES = 30;
const BODY_STUDY = [0, 11, 12, 15, 16, 23, 24];
const HAND_STUDY = [0, 5, 17, 4, 8, 20];
const BODY_PRECISION = 40;
const HAND_PRECISION = 40;
const PROBABILITY_THRESHOLD = 0.9;
const MATCH_HOLD = 10;
const REPLAY_MS = 15000;
const CORRECTION_IDLE_MS = 15000;

interface SampleFrame {
  body: Array<[number, number]>;
  right_hand: Array<[number, number]>;
  left_hand: Array<[number, number]>;
}

type Phase = 'mimic' | 'correction' | 'done';

export function createSignTrainingLayer(deps: LayerDeps): Layer {
  const tracker = new SignTracker();

  // The action sequence (skip the "nothing"/"empty" sentinels).
  const actions = [
    'ok',
    'yes',
    'no',
    'left',
    'right',
    'house',
    'store',
    'hello',
    'goodbye',
    'television',
    'leave',
    'eat',
    'apple',
    'peach',
  ];

  let targetIdx = 0;
  let phase: Phase = 'mimic';
  let matchCount = 0;
  let lastReplay = 0;
  const sentence: string[] = [];

  // Reference video for the current target sign.
  let video: HTMLVideoElement | null = null;

  // Correction state.
  let sampleFrames: SampleFrame[] = [];
  let samplesLoading = false;
  let frameIdx = 0;
  let aligned = false;
  let ratio = 1;
  let offset: [number, number] = [0, 0];
  let lastDetected = 0;

  const target = (): string => actions[targetIdx] ?? '';

  function videoUrl(sign: string): string {
    return deps.assetUrl(`sign-training/videos/${sign.replace(/ /g, '_')}.webm`);
  }

  function startMimic(now: number): void {
    phase = 'mimic';
    matchCount = 0;
    lastReplay = now;
    const url = videoUrl(target());
    video = getVideo(url);
    void video.play().catch(() => undefined);
  }

  async function loadSamples(sign: string): Promise<void> {
    samplesLoading = true;
    const frames: SampleFrame[] = [];
    try {
      const reqs = Array.from({ length: SAMPLE_FRAMES }, (_, i) =>
        fetch(deps.assetUrl(`sign-training/slr_samples/${sign}/${i}.json`)).then(
          (r) => r.json() as Promise<number[]>,
        ),
      );
      const raw = await Promise.all(reqs);
      for (const flat of raw) frames.push(parseSampleFrame(flat));
      sampleFrames = frames;
    } catch (err) {
      deps.rt.log.warn('sign-training: sample load failed', { sign, err: String(err) });
      sampleFrames = [];
    }
    samplesLoading = false;
  }

  function enterCorrection(now: number): void {
    phase = 'correction';
    frameIdx = 0;
    aligned = false;
    sampleFrames = [];
    lastDetected = now;
    void loadSamples(target());
  }

  function nextTarget(now: number): void {
    targetIdx++;
    if (targetIdx >= actions.length) {
      phase = 'done';
      return;
    }
    startMimic(now);
  }

  function updateMimic(now: number): void {
    if (!video) {
      startMimic(now);
      return;
    }
    if (now - lastReplay > REPLAY_MS) {
      lastReplay = now;
      video.currentTime = 0;
      void video.play().catch(() => undefined);
    }

    // Track recognised signs into the sentence history.
    if (
      tracker.probability > PROBABILITY_THRESHOLD &&
      tracker.sign &&
      tracker.sign !== 'nothing' &&
      tracker.sign !== 'empty'
    ) {
      if (sentence[sentence.length - 1] !== tracker.sign) sentence.push(tracker.sign);
      if (sentence.length > 5) sentence.shift();
    }

    if (tracker.sign === target()) matchCount++;
    else matchCount = 0;

    if (matchCount >= MATCH_HOLD) enterCorrection(now);
  }

  function updateCorrection(now: number): void {
    if (sampleFrames.length < SAMPLE_FRAMES) return;
    if (frameIdx >= SAMPLE_FRAMES) {
      nextTarget(now);
      return;
    }
    const body = deps.feed.mirror.data.body_pose;
    if (body.length <= 24) return;

    if (!aligned) {
      align(body);
      aligned = true;
      lastDetected = now;
      return;
    }

    if (now - lastDetected > CORRECTION_IDLE_MS) {
      // Give up on this sign; move on.
      nextTarget(now);
      return;
    }

    const frame = sampleFrames[frameIdx]!;
    const bodyDiff = meanDistance(frame.body, body, BODY_STUDY);
    const rightDiff = handDiff(frame.right_hand, deps.feed.mirror.data.right_hand_pose);
    const leftDiff = handDiff(frame.left_hand, deps.feed.mirror.data.left_hand_pose);

    if (bodyDiff < BODY_PRECISION && rightDiff < HAND_PRECISION && leftDiff < HAND_PRECISION) {
      frameIdx++;
      lastDetected = now;
    }
  }

  function align(body: Landmark[]): void {
    const nose = body[0]!;
    const hip = body[24]!;
    const sample = sampleFrames[0]!;
    const sNose = sample.body[0]!;
    const sHip = sample.body[24]!;
    const mirrorDist = dist(nose[0]!, nose[1]!, hip[0]!, hip[1]!);
    const sampleDist = dist(sNose[0], sNose[1], sHip[0], sHip[1]) || 1;
    ratio = mirrorDist / sampleDist;
    offset = [nose[0]! - sNose[0] * ratio, nose[1]! - sNose[1] * ratio];
  }

  function meanDistance(
    samplePts: Array<[number, number]>,
    userPts: Landmark[],
    indices: number[],
  ): number {
    let sum = 0;
    let count = 0;
    for (const i of indices) {
      const s = samplePts[i];
      const u = userPts[i];
      if (!s || !u) continue;
      sum += dist(offset[0] + s[0] * ratio, offset[1] + s[1] * ratio, u[0]!, u[1]!);
      count++;
    }
    return count > 0 ? sum / (count * ratio) : Number.POSITIVE_INFINITY;
  }

  function handDiff(samplePts: Array<[number, number]>, userPts: Landmark[]): number {
    // Legacy: only score hands that are present in the sample (non-zero origin).
    if (!samplePts[0] || (samplePts[0][0] === 0 && samplePts[0][1] === 0)) return 0;
    if (!userPts || userPts.length === 0) return 0;
    return meanDistance(samplePts, userPts, HAND_STUDY);
  }

  function transform(pts: Array<[number, number]>): Landmark[] {
    return pts.map(([x, y]) => [offset[0] + x * ratio, offset[1] + y * ratio]);
  }

  return {
    start(): void {
      targetIdx = 0;
      sentence.length = 0;
      tracker.reset();
      startMimic(performance.now());
    },

    render(frame: FrameContext): void {
      const { ctx, timestamp } = frame;
      tracker.update(deps.feed);

      if (phase === 'mimic') updateMimic(timestamp);
      else if (phase === 'correction') updateCorrection(timestamp);

      // Reference video (mimic phase).
      if (phase === 'mimic' && video && ensureVideoPlaying(video)) {
        const vw = 600;
        const vh = (video.videoHeight / video.videoWidth) * vw || 380;
        ctx.drawImage(video, REF_WIDTH / 2 - vw / 2, 60, vw, vh);
        strokeRect(ctx, REF_WIDTH / 2 - vw / 2, 60, vw, vh, 4, '#ffffff');
      }

      // Correction overlay skeleton.
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
        } else if (aligned && frameIdx < SAMPLE_FRAMES) {
          const f = sampleFrames[frameIdx]!;
          drawBody(ctx, transform(f.body), {
            color: '#32fAff',
            weight: 8,
            minVisibility: 0,
            showHead: true,
            showWrist: true,
          });
          drawHand(ctx, transform(f.right_hand), { color: '#32fAff', weight: 6 });
          drawHand(ctx, transform(f.left_hand), { color: '#32fAff', weight: 6 });
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
          fillRect(ctx, 0, REF_HEIGHT - 40, REF_WIDTH * (frameIdx / SAMPLE_FRAMES), 12, '#32fAff');
        }
      }

      if (phase === 'done') {
        drawText(ctx, 'Well done!', REF_WIDTH / 2, REF_HEIGHT / 2, 56, '#fff', 'center', 'middle');
        return;
      }

      drawHud(ctx);
    },

    stop(): void {
      if (video) {
        video.pause();
        video = null;
      }
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

// ---------------------------------------------------------------------------
// Sample frame parsing
// ---------------------------------------------------------------------------

/**
 * Sample frame layout (flat float list): 33 body (x,y) + 21 right-hand (x,y) +
 * 21 left-hand (x,y) = 150 values.
 */
function parseSampleFrame(flat: number[]): SampleFrame {
  const body = readPairs(flat, 0, 33);
  const right_hand = readPairs(flat, 33 * 2, 21);
  const left_hand = readPairs(flat, 33 * 2 + 21 * 2, 21);
  return { body, right_hand, left_hand };
}

function readPairs(flat: number[], start: number, count: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < count; i++) {
    out.push([flat[start + i * 2] ?? 0, flat[start + i * 2 + 1] ?? 0]);
  }
  return out;
}

function dist(x1: number, y1: number, x2: number, y2: number): number {
  return Math.hypot(x1 - x2, y1 - y2);
}
