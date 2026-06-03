/**
 * Theremine: a hand-controlled instrument.
 *
 * Ports the legacy `theremine` app (components/theremine.js). The rightmost
 * point of the right hand selects the pitch (x -> frequency); the lowest point
 * of the left hand selects the loudness (y -> amplitude). Audio is synthesized
 * in-browser via the shared {@link Synth}; the "Sound" option toggles it.
 */

import { fillCircle, fillRect, strokeLine, strokeRect } from '../shared/canvas.js';
import type { LayerDeps } from '../shared/deps.js';
import { keyToFreq, MUSICAL_ELEMENTS } from '../shared/music.js';
import { ParticleSystem } from '../shared/particles.js';
import type { Landmark } from '../shared/types.js';
import { REF_HEIGHT, type FrameContext, type Layer } from '../shared/types.js';

const GAP = 14;
const SHIFT = 50;
const CURSOR_Y = 200;
const BLUE = { r: 0, g: 191, b: 255 };
const RED = { r: 245, g: 34, b: 34 };

export function createTheremineLayer(deps: LayerDeps): Layer {
  const particles = new ParticleSystem(200);
  let frequency = 0;
  let amplitude = 0;

  const keyToPxl = (key: number): number => key * GAP - SHIFT;
  const pxToFreq = (px: number): number => {
    const keyNum = (px + SHIFT) / GAP;
    return Math.min(Math.max(keyToFreq(keyNum), 0), 2000);
  };
  const pxToAmp = (py: number): number => Math.min(Math.max((REF_HEIGHT / 2 - py) / 100, 0), 7);

  function rightmost(hand: Landmark[]): Landmark | null {
    let best: Landmark | null = null;
    for (const p of hand) if (Array.isArray(p) && (!best || p[0]! > best[0]!)) best = p;
    return best;
  }
  function lowest(hand: Landmark[]): Landmark | null {
    let best: Landmark | null = null;
    for (const p of hand) if (Array.isArray(p) && (!best || p[1]! > best[1]!)) best = p;
    return best;
  }

  return {
    start(): void {
      particles.clear();
      frequency = 0;
      amplitude = 0;
    },

    render(frame: FrameContext): void {
      const { ctx } = frame;
      const m = deps.feed.mirror.data;
      const right = m.right_hand_pose;
      const left = m.left_hand_pose;

      const rPoint = right.length ? rightmost(right) : null;
      const lPoint = left.length ? lowest(left) : null;

      if (rPoint && lPoint) {
        frequency = pxToFreq(rPoint[0]!);
        amplitude = pxToAmp(lPoint[1]!);
      } else {
        frequency = 0;
        amplitude = 0;
      }

      const soundOn = deps.controller.getOption('theremine', 'Sound');
      deps.synth.setLive(soundOn ? frequency : 0, amplitude / 7);

      drawBars(ctx, keyToPxl);

      if (rPoint && right[11]) {
        const cy = right[11]![1]! - 40;
        fillCircle(ctx, rPoint[0]!, cy, 10, 'rgb(0,191,255)');
        if (Math.floor(Math.random() * 5) === 0) particles.add(rPoint[0]!, cy, BLUE);
      }
      if (lPoint && left[4]) {
        const cx = lPoint[0]! + 60;
        fillCircle(ctx, cx, left[4]![1]!, 10, 'rgb(245,34,34)');
        if (Math.floor(Math.random() * 5) === 0) particles.add(cx, left[4]![1]!, RED);
      }
      particles.run(ctx);
    },

    stop(): void {
      deps.synth.setLive(0, 0);
      particles.clear();
    },
  };
}

function drawBars(ctx: CanvasRenderingContext2D, keyToPxl: (k: number) => number): void {
  const keys = MUSICAL_ELEMENTS.notes_key;
  // White keys + guide lines.
  for (const note of Object.keys(keys)) {
    if (note.includes('#') || keys[note]! < 0) continue;
    const x = keyToPxl(keys[note]!);
    strokeLine(ctx, x, CURSOR_Y, x, CURSOR_Y + 500, 2, 'rgba(255,255,255,0.35)');
    const w = GAP * 1.2;
    fillRect(ctx, x - w / 2, CURSOR_Y, w, 150, 'rgba(255,255,255,0.9)');
    strokeRect(ctx, x - w / 2, CURSOR_Y, w, 150, 2, '#000');
  }
  // Black keys on top.
  for (const note of Object.keys(keys)) {
    if (!note.includes('#')) continue;
    const x = keyToPxl(keys[note]!);
    const w = GAP * 1.2;
    fillRect(ctx, x - w / 2, CURSOR_Y, w, 100, 'rgb(16,16,16)');
  }
}
