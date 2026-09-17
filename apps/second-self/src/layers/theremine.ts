/**
 * Theremine: a hand-controlled instrument.
 *
 * The rightmost point of the right hand selects the pitch (x to frequency);
 * the lowest point of the left hand selects the loudness (y to amplitude).
 * The shared {@link Synth} plays the tone; the "Sound" option toggles it. The
 * tone stops whenever the layer stops or the compositor suspends.
 */

import type { LayerDeps } from '../shared/deps.js';
import { fillCircle } from '../shared/draw.js';
import { drawKeyboard, keyToFreq } from '../shared/music.js';
import { ParticleSystem } from '../shared/particles.js';
import { REF_HEIGHT, type Landmark, type Layer } from '../shared/types.js';

const GAP = 14;
const SHIFT = 50;
const CURSOR_Y = 200;
const MAX_AMPLITUDE = 7;
const PARTICLE_LIFE_MS = 3300;
const PARTICLES_PER_S = 12;
const BLUE = { r: 0, g: 191, b: 255 };
const RED = { r: 245, g: 34, b: 34 };

const keyToPx = (key: number): number => key * GAP - SHIFT;
const pxToFreq = (px: number): number => Math.min(Math.max(keyToFreq((px + SHIFT) / GAP), 0), 2000);
const pxToAmp = (py: number): number =>
  Math.min(Math.max((REF_HEIGHT / 2 - py) / 100, 0), MAX_AMPLITUDE);

export function createTheremineLayer(deps: LayerDeps): Layer {
  const particles = new ParticleSystem(PARTICLE_LIFE_MS);
  const silence = (): void => deps.synth.setLive(0, 0);

  return {
    start(): void {
      particles.clear();
    },

    render({ ctx, deltaMs }): void {
      const { right_hand_pose: right, left_hand_pose: left } = deps.feed.mirror.data;
      const rPoint = extreme(right, (p, best) => p[0]! > best[0]!);
      const lPoint = extreme(left, (p, best) => p[1]! > best[1]!);

      if (rPoint && lPoint && deps.options.get('theremine', 'Sound')) {
        deps.synth.setLive(pxToFreq(rPoint[0]!), pxToAmp(lPoint[1]!) / MAX_AMPLITUDE);
      } else {
        silence();
      }

      drawKeyboard(ctx, keyToPx, {
        y: CURSOR_Y,
        whiteWidth: GAP * 1.2,
        whiteHeight: 150,
        blackWidth: GAP * 1.2,
        blackHeight: 100,
        guideLength: 500,
      });

      const rightKnuckle = right[11];
      if (rPoint && rightKnuckle) {
        const cy = rightKnuckle[1]! - 40;
        fillCircle(ctx, rPoint[0]!, cy, 10, 'rgb(0,191,255)');
        particles.emit(rPoint[0]!, cy, BLUE, PARTICLES_PER_S, deltaMs);
      }
      const leftThumb = left[4];
      if (lPoint && leftThumb) {
        const cx = lPoint[0]! + 60;
        fillCircle(ctx, cx, leftThumb[1]!, 10, 'rgb(245,34,34)');
        particles.emit(cx, leftThumb[1]!, RED, PARTICLES_PER_S, deltaMs);
      }
      particles.run(ctx, deltaMs);
    },

    suspend: silence,

    stop(): void {
      silence();
      particles.clear();
    },
  };
}

/** The landmark that beats every other one by `better`, or null for an empty hand. */
function extreme(
  hand: readonly Landmark[],
  better: (p: Landmark, best: Landmark) => boolean,
): Landmark | null {
  let best: Landmark | null = null;
  for (const p of hand) if (!best || better(p, best)) best = p;
  return best;
}
