/**
 * Dance: follow a reference choreography.
 *
 * Ports the legacy `dance` app (components/dance.js). A reference dancer (the
 * `dance02.gif`) is overlaid, scaled and positioned to the user via a
 * nose/hip anchor. The user advances through the choreography (`dance02.json`)
 * only by matching each target pose: the mean keypoint distance over a set of
 * studied joints must drop below a threshold. A countdown limits each attempt.
 *
 * The reference gif is played frame-accurately via the `ImageDecoder` API when
 * available (Chromium app-host), falling back to an animated <img> overlay.
 */

import { drawText, fillRect, strokeLine } from '../shared/canvas.js';
import type { LayerDeps } from '../shared/deps.js';
import { REF_HEIGHT, type FrameContext, type Layer } from '../shared/types.js';

const STUDIED = [0, 11, 12, 15, 16, 23, 24];
const LIMIT = 120;
const TIME_LIMIT = 1000;

type Moves = Record<string, Array<[number, number, number]>> & {
  size: [number, number];
  length: number;
};

interface GifFrames {
  frameCount: number;
  decode(index: number): Promise<ImageBitmap | null>;
}

export function createDanceLayer(deps: LayerDeps): Layer {
  let moves: Moves | null = null;
  let gif: GifFrames | null = null;
  let fallbackImg: HTMLImageElement | null = null;

  let frameBitmap: ImageBitmap | null = null;
  let decodedIndex = -1;
  let decoding = false;

  let init = false;
  let offset: [number, number] = [0, 0];
  let ratio = 1;
  let size: [number, number] = [1080, 1920];
  let movesIndex = 0;
  let videoIndex = 0;
  let diff = 0;
  let time = 0;

  function reset(): void {
    init = false;
    offset = [0, 0];
    ratio = 1;
    size = moves ? [...moves.size] : [1080, 1920];
    movesIndex = 0;
    videoIndex = 0;
    diff = 0;
    time = 0;
  }

  return {
    async preload(): Promise<void> {
      const movesUrl = deps.assetUrl('dance/dance02.json');
      const gifUrl = deps.assetUrl('dance/dance02.gif');
      try {
        const resp = await fetch(movesUrl);
        moves = (await resp.json()) as Moves;
      } catch (err) {
        deps.rt.log.warn('dance: failed to load moves', { err: String(err) });
      }
      gif = await loadGif(gifUrl).catch(() => null);
      if (!gif) {
        fallbackImg = new Image();
        fallbackImg.src = gifUrl;
      }
    },

    start(): void {
      reset();
    },

    render(frame: FrameContext): void {
      const { ctx } = frame;
      update();
      drawReference(ctx);
      drawHud(ctx);
    },

    stop(): void {
      frameBitmap?.close();
      frameBitmap = null;
      decodedIndex = -1;
    },
  };

  function update(): void {
    if (!moves) return;
    const body = deps.feed.mirror.data.body_pose;

    if (movesIndex >= moves.length - 5) {
      deps.controller.stop('dance');
      reset();
      return;
    }
    if (!body || body.length <= 0) return;

    if (!init) {
      const move0 = moves['0'];
      if (!move0) return;
      init = true;
      const mirrorNose = body[0]!;
      const mirrorHip = body[24]!;
      const videoNose = move0[0]!;
      const videoHip = move0[23]!;
      const mirrorDist = dist(mirrorNose[0]!, mirrorNose[1]!, mirrorHip[0]!, mirrorHip[1]!);
      const videoDist = dist(videoNose[1], videoNose[2], videoHip[1], videoHip[2]);
      ratio = videoDist > 0 ? mirrorDist / videoDist : 1;
      size = [moves.size[0] * ratio, moves.size[1] * ratio];
      offset = [mirrorNose[0]! - videoNose[1] * ratio, mirrorNose[1]! - videoNose[2] * ratio];
      return;
    }

    time++;
    if (time > TIME_LIMIT) {
      deps.controller.stop('dance');
      reset();
      return;
    }

    const move = moves[String(movesIndex)];
    if (move) {
      let sum = 0;
      for (const idx of STUDIED) {
        const v = move[idx];
        const b = body[idx];
        if (!v || !b) continue;
        sum += dist(offset[0] + v[1] * ratio, offset[1] + v[2] * ratio, b[0]!, b[1]!);
      }
      diff = sum / STUDIED.length;
      if (diff < LIMIT) {
        movesIndex++;
        time = Math.max(0, time - 5);
      }
    } else {
      movesIndex++;
    }

    if (movesIndex > videoIndex) videoIndex = movesIndex;
  }

  function drawReference(ctx: CanvasRenderingContext2D): void {
    if (gif) {
      ensureFrame(videoIndex);
      if (frameBitmap) ctx.drawImage(frameBitmap, offset[0], offset[1], size[0], size[1]);
    } else if (fallbackImg && fallbackImg.complete && fallbackImg.naturalWidth > 0) {
      ctx.drawImage(fallbackImg, offset[0], offset[1], size[0], size[1]);
    }
  }

  function ensureFrame(index: number): void {
    if (!gif || decoding) return;
    const clamped = Math.max(0, Math.min(index, gif.frameCount - 1));
    if (clamped === decodedIndex) return;
    decoding = true;
    void gif
      .decode(clamped)
      .then((bmp) => {
        if (bmp) {
          frameBitmap?.close();
          frameBitmap = bmp;
          decodedIndex = clamped;
        }
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
      diff < LIMIT ? 'rgb(166,216,84)' : 'rgb(215,25,28)',
    );
    strokeLine(ctx, 60, REF_HEIGHT - 50 - 3 * LIMIT, 100, REF_HEIGHT - 50 - 3 * LIMIT, 2, '#fff');

    // Countdown ring.
    ctx.save();
    ctx.translate(80, 180);
    ctx.rotate(-Math.PI / 2);
    const sweep = (1 - time / TIME_LIMIT) * Math.PI * 2;
    ctx.strokeStyle = '#fff';
    ctx.fillStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, 30, 0, sweep);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}

async function loadGif(url: string): Promise<GifFrames | null> {
  const Decoder = (globalThis as unknown as { ImageDecoder?: unknown }).ImageDecoder as
    | (new (init: { data: ArrayBuffer; type: string }) => {
        tracks: { ready: Promise<void>; selectedTrack?: { frameCount: number } };
        decode(opts: { frameIndex: number }): Promise<{ image: { close?: () => void } }>;
      })
    | undefined;
  if (!Decoder) return null;
  try {
    const resp = await fetch(url);
    const buf = await resp.arrayBuffer();
    const dec = new Decoder({ data: buf, type: 'image/gif' });
    await dec.tracks.ready;
    const frameCount = dec.tracks.selectedTrack?.frameCount ?? 1;
    return {
      frameCount,
      async decode(index: number): Promise<ImageBitmap | null> {
        try {
          const { image } = await dec.decode({
            frameIndex: Math.max(0, Math.min(index, frameCount - 1)),
          });
          const bmp = await createImageBitmap(image as unknown as ImageBitmapSource);
          image.close?.();
          return bmp;
        } catch {
          return null;
        }
      },
    };
  } catch {
    return null;
  }
}

function dist(x1: number, y1: number, x2: number, y2: number): number {
  return Math.hypot(x1 - x2, y1 - y2);
}
