/**
 * Dance: follow a reference choreography.
 *
 * A reference dancer (the `dance02.webp` animation) is overlaid, scaled and
 * positioned to the user via a nose/hip anchor. The user advances through the
 * choreography (`dance02.json`) only by matching each target pose: the mean
 * keypoint distance over a set of studied joints must drop below a threshold.
 * A countdown limits each attempt.
 *
 * Scoring is translation-invariant: each target pose is compared relative to
 * the current move's nose, anchored at the user's nose, so only the pose
 * shape must match. The pass threshold is proportional to the user's
 * on-screen body size (nose-hip distance), so it works at any distance,
 * screen size or calibration. The drawing anchor re-fits continuously
 * (smoothed), and low-visibility joints are left out of the score.
 *
 * The reference animation plays frame-accurately through `ImageDecoder` when
 * the browser has it, and falls back to an animated <img>.
 */

import { fitNoseHip } from '../shared/align.js';
import type { LayerDeps } from '../shared/deps.js';
import { drawText, fillRect, strokeLine } from '../shared/draw.js';
import { isValid } from '../shared/mirror.js';
import { REF_HEIGHT, type Landmark, type Layer } from '../shared/types.js';
import { dist, drawProgressRing } from '../shared/ui.js';

/**
 * Joints scored against the reference pose (shoulders, wrists, hips). The
 * nose is the alignment anchor, so it isn't scored.
 */
const SCORED = [11, 12, 15, 16, 23, 24];
/** Pass threshold as a fraction of the user's nose-hip distance, clamped. */
const THRESHOLD_RATIO = 0.3;
const THRESHOLD_MIN_PX = 60;
const THRESHOLD_MAX_PX = 220;
/** Minimum landmark visibility for a joint to enter the score. */
const MIN_JOINT_VISIBILITY = 0.5;
/** Minimum scored joints for a frame to count (avoids trivial passes). */
const MIN_SCORED_JOINTS = 4;
/** Smoothing rate for the continuous nose/hip anchor re-fit. */
const ANCHOR_LERP = 0.15;
/** Attempt time budget. Matched moves refund a little time. */
const TIME_LIMIT_MS = 33_000;
const MATCH_REFUND_MS = 166;
/** The choreography ends this many moves before its last frame. */
const END_MARGIN = 5;

/** A move: `[landmark index, x, y]` per landmark, in reference-video pixels. */
type Move = ReadonlyArray<readonly [number, number, number]>;

interface Choreography {
  readonly moves: ReadonlyMap<number, Move>;
  readonly length: number;
  readonly size: readonly [number, number];
}

export function createDanceLayer(deps: LayerDeps): Layer {
  let choreography: Choreography | null = null;
  let referenceData: ArrayBuffer | null = null;
  let fallbackImg: HTMLImageElement | null = null;

  // Per activation.
  let decoder: ImageDecoder | null = null;
  let frameCount = 1;
  let frameBitmap: ImageBitmap | null = null;
  let decodedIndex = -1;
  let decoding = false;

  let init = false;
  let offset: [number, number] = [0, 0];
  let ratio = 1;
  let size: [number, number] = [1080, 1920];
  let threshold = THRESHOLD_MIN_PX;
  let movesIndex = 0;
  let videoIndex = 0;
  let diff = 0;
  let elapsedMs = 0;

  function reset(): void {
    init = false;
    offset = [0, 0];
    ratio = 1;
    size = choreography ? [...choreography.size] : [1080, 1920];
    threshold = THRESHOLD_MIN_PX;
    movesIndex = 0;
    videoIndex = 0;
    diff = 0;
    elapsedMs = 0;
  }

  function createFallback(): HTMLImageElement {
    const img = new Image();
    img.src = deps.asset('dance/dance02.webp');
    return img;
  }

  function finish(): void {
    void deps.layers.stop('dance');
    reset();
  }

  return {
    async preload(): Promise<void> {
      await deps.assets.require('dance', ['dance/dance02.json', 'dance/dance02.webp']);
      const referenceUrl = deps.asset('dance/dance02.webp');
      try {
        choreography = parseChoreography(await fetchOk(deps.asset('dance/dance02.json'), 'json'));
      } catch (err) {
        deps.rt.log.warn('dance: failed to load the choreography', { err: String(err) });
      }
      if (typeof ImageDecoder !== 'undefined') {
        referenceData = await fetchOk(referenceUrl, 'arrayBuffer').catch(() => null);
      }
      if (!referenceData) fallbackImg = createFallback();
    },

    async start(): Promise<void> {
      reset();
      if (!referenceData) return;
      let next: ImageDecoder | null = null;
      try {
        next = new ImageDecoder({ data: referenceData, type: 'image/webp' });
        decoder = next;
        await next.tracks.ready;
        frameCount = next.tracks.selectedTrack?.frameCount ?? 1;
      } catch (err) {
        // The layer stopped meanwhile and closed the decoder.
        if (decoder !== next) return;
        deps.rt.log.warn('dance: the reference animation can not be decoded', {
          err: String(err),
        });
        next?.close();
        decoder = null;
        // Play the animated image instead, from now on.
        referenceData = null;
        fallbackImg ??= createFallback();
      }
    },

    render({ ctx, deltaMs }): void {
      update(deltaMs);
      drawReference(ctx);
      drawHud(ctx);
    },

    stop(): void {
      decoder?.close();
      decoder = null;
      frameBitmap?.close();
      frameBitmap = null;
      decodedIndex = -1;
    },
  };

  function update(deltaMs: number): void {
    if (!choreography) return;
    const body = deps.feed.mirror.data.body_pose;

    if (movesIndex >= choreography.length - END_MARGIN) {
      finish();
      return;
    }
    if (body.length === 0) return;

    updateAnchor(body, choreography);
    if (!init) return;

    elapsedMs += deltaMs;
    if (elapsedMs > TIME_LIMIT_MS) {
      finish();
      return;
    }

    const move = choreography.moves.get(movesIndex);
    if (move) {
      // Expected joint positions are the move's joints relative to the move's
      // nose, scaled to the user and anchored at the user's nose. Where the
      // user stands doesn't matter; only the pose shape must match.
      const userNose = body[0];
      const moveNose = move[0];
      if (moveNose && isValid(userNose) && (userNose[3] ?? 1) >= MIN_JOINT_VISIBILITY) {
        let sum = 0;
        let count = 0;
        for (const idx of SCORED) {
          const v = move[idx];
          const b = body[idx];
          if (!v || !isValid(b) || (b[3] ?? 1) < MIN_JOINT_VISIBILITY) continue;
          const ex = userNose[0]! + (v[1] - moveNose[1]) * ratio;
          const ey = userNose[1]! + (v[2] - moveNose[2]) * ratio;
          sum += dist(ex, ey, b[0]!, b[1]!);
          count++;
        }
        if (count >= MIN_SCORED_JOINTS) {
          diff = sum / count;
          if (diff < threshold) {
            movesIndex++;
            elapsedMs = Math.max(0, elapsedMs - MATCH_REFUND_MS);
          }
        }
      }
    } else {
      movesIndex++;
    }

    // Step the reference animation one frame per tick toward the current move
    // so the dancer animates smoothly instead of jumping.
    if (movesIndex > videoIndex) videoIndex++;
  }

  /**
   * Re-fits the video-to-mirror anchor from the user's nose and hip, smoothed
   * so the reference dancer doesn't jitter, and derives the body-size-relative
   * pass threshold.
   */
  function updateAnchor(body: readonly Landmark[], dance: Choreography): void {
    const move0 = dance.moves.get(0);
    const videoNose = move0?.[0];
    const videoHip = move0?.[23];
    const mirrorNose = body[0];
    const mirrorHip = body[24];
    if (!videoNose || !videoHip || !isValid(mirrorNose) || !isValid(mirrorHip)) return;
    if ((mirrorNose[3] ?? 1) < MIN_JOINT_VISIBILITY || (mirrorHip[3] ?? 1) < MIN_JOINT_VISIBILITY) {
      return;
    }
    const fit = fitNoseHip(
      [mirrorNose[0]!, mirrorNose[1]!],
      [mirrorHip[0]!, mirrorHip[1]!],
      [videoNose[1], videoNose[2]],
      [videoHip[1], videoHip[2]],
    );
    if (!fit) return;

    if (!init) {
      init = true;
      ratio = fit.ratio;
      offset = [fit.offsetX, fit.offsetY];
    } else {
      ratio += (fit.ratio - ratio) * ANCHOR_LERP;
      offset[0] += (fit.offsetX - offset[0]) * ANCHOR_LERP;
      offset[1] += (fit.offsetY - offset[1]) * ANCHOR_LERP;
    }
    size = [dance.size[0] * ratio, dance.size[1] * ratio];
    const mirrorSpan = dist(mirrorNose[0]!, mirrorNose[1]!, mirrorHip[0]!, mirrorHip[1]!);
    threshold = Math.min(
      THRESHOLD_MAX_PX,
      Math.max(THRESHOLD_MIN_PX, mirrorSpan * THRESHOLD_RATIO),
    );
  }

  function drawReference(ctx: CanvasRenderingContext2D): void {
    if (decoder) {
      requestFrame(decoder, videoIndex);
      if (frameBitmap) ctx.drawImage(frameBitmap, offset[0], offset[1], size[0], size[1]);
    } else if (fallbackImg?.complete && fallbackImg.naturalWidth > 0) {
      ctx.drawImage(fallbackImg, offset[0], offset[1], size[0], size[1]);
    }
  }

  function requestFrame(active: ImageDecoder, index: number): void {
    const clamped = Math.max(0, Math.min(index, frameCount - 1));
    if (decoding || clamped === decodedIndex) return;
    decoding = true;
    void decodeFrame(active, clamped)
      .then((bitmap) => {
        // The layer stopped while decoding: this bitmap belongs to nobody.
        if (decoder !== active) {
          bitmap?.close();
          return;
        }
        if (!bitmap) return;
        frameBitmap?.close();
        frameBitmap = bitmap;
        decodedIndex = clamped;
      })
      .finally(() => {
        decoding = false;
      });
  }

  function drawHud(ctx: CanvasRenderingContext2D): void {
    drawText(ctx, `${Math.floor(diff)}`, 80, 80, 30, '#fff', 'center', 'middle');

    const barHeight = Math.min(diff * 3, REF_HEIGHT - 50 - 400);
    fillRect(
      ctx,
      65,
      REF_HEIGHT - 50 - barHeight,
      30,
      barHeight,
      diff < threshold ? 'rgb(166,216,84)' : 'rgb(215,25,28)',
    );
    const thresholdY = REF_HEIGHT - 50 - 3 * threshold;
    strokeLine(ctx, 60, thresholdY, 100, thresholdY, 2, '#fff');

    drawProgressRing(ctx, 80, 180, 30, 1 - elapsedMs / TIME_LIMIT_MS, {
      color: '#fff',
      fill: true,
    });
  }
}

async function decodeFrame(decoder: ImageDecoder, frameIndex: number): Promise<ImageBitmap | null> {
  try {
    const { image } = await decoder.decode({ frameIndex });
    try {
      return await createImageBitmap(image);
    } finally {
      image.close();
    }
  } catch {
    return null;
  }
}

async function fetchOk(url: string, as: 'json'): Promise<unknown>;
async function fetchOk(url: string, as: 'arrayBuffer'): Promise<ArrayBuffer>;
async function fetchOk(url: string, as: 'json' | 'arrayBuffer'): Promise<unknown> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`${url}: HTTP ${resp.status}`);
  return as === 'json' ? resp.json() : resp.arrayBuffer();
}

/** Reads `dance02.json`: moves keyed by index, plus `size` and `length`. */
function parseChoreography(value: unknown): Choreography {
  if (typeof value !== 'object' || value === null) throw new Error('not an object');
  const moves = new Map<number, Move>();
  let size: readonly [number, number] = [1080, 1920];
  let length = 0;
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'size' && isNumbers(entry, 2)) size = [entry[0]!, entry[1]!];
    else if (key === 'length' && typeof entry === 'number') length = entry;
    else if (/^\d+$/.test(key) && Array.isArray(entry)) {
      const rows = entry.filter((row) => isNumbers(row, 3));
      moves.set(
        Number(key),
        rows.map((row) => [row[0]!, row[1]!, row[2]!] as const),
      );
    }
  }
  return { moves, length, size };
}

function isNumbers(value: unknown, count: number): value is number[] {
  return (
    Array.isArray(value) &&
    value.length >= count &&
    value.slice(0, count).every((n) => typeof n === 'number')
  );
}
