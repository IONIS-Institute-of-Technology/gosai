/**
 * Ambient display.
 *
 * 50 randomly coloured dots drift across the table, wrapping at the edges,
 * and a firework bursts every 3 seconds, up to 6 at once. Burst particles
 * slow down and fade out. Speeds are the legacy per-frame steps, scaled by
 * the frame time.
 */

import { rand } from '../shared/math.js';
import { frameSteps, stepParticle, wrap, type Particle } from '../shared/motion.js';
import { REF_HEIGHT, REF_WIDTH, type PoolFrame, type PoolLayer } from '../shared/types.js';

const DOT_COUNT = 50;
const MAX_FIREWORKS = 6;
const PARTICLE_COUNT = 100;
const VEL_DRAG = 0.991;
const ALPHA_DRAG = 0.99;
const FIRE_INTERVAL_MS = 3000;
/** Particles fainter than this are skipped, and a burst of them is removed. */
const MIN_ALPHA = 2;

interface Dot {
  x: number;
  y: number;
  readonly vx: number;
  readonly vy: number;
  readonly color: string;
}

interface Spark extends Particle {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export function createAmbientDisplayLayer(): PoolLayer {
  let dots: Dot[] = [];
  let fireworks: Spark[][] = [];
  let lastFireAt = 0;

  return {
    start(): void {
      dots = Array.from({ length: DOT_COUNT }, () => ({
        x: rand(0, REF_WIDTH),
        y: rand(0, REF_HEIGHT),
        vx: rand(-2, 2),
        vy: rand(-2, 2),
        color: `rgb(${randomChannel()},${randomChannel()},${randomChannel()})`,
      }));
      fireworks = [];
      lastFireAt = 0;
    },

    render({ ctx, timestamp, deltaMs }: PoolFrame): void {
      const steps = frameSteps(deltaMs);

      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, REF_WIDTH, REF_HEIGHT);

      for (const dot of dots) {
        dot.x = wrap(dot.x + dot.vx * steps, REF_WIDTH);
        dot.y = wrap(dot.y + dot.vy * steps, REF_HEIGHT);
        ctx.fillStyle = dot.color;
        ctx.fillRect(dot.x - 3.5, dot.y - 3.5, 7, 7);
      }

      if (timestamp - lastFireAt > FIRE_INTERVAL_MS && fireworks.length < MAX_FIREWORKS) {
        lastFireAt = timestamp;
        fireworks.push(burst());
      }

      fireworks = fireworks.filter((sparks) => sparks.some((p) => p.alpha > MIN_ALPHA));
      for (const sparks of fireworks) {
        for (const p of sparks) {
          if (p.alpha <= MIN_ALPHA) continue;
          ctx.fillStyle = `rgba(${p.r},${p.g},${p.b},${(p.alpha / 255).toFixed(3)})`;
          ctx.beginPath();
          ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
          ctx.fill();
          stepParticle(p, steps, VEL_DRAG, ALPHA_DRAG);
        }
      }
    },

    stop(): void {
      dots = [];
      fireworks = [];
    },
  };
}

function burst(): Spark[] {
  const x = rand(REF_WIDTH * 0.1, REF_WIDTH * 0.9);
  const y = rand(REF_HEIGHT * 0.1, REF_HEIGHT * 0.9);
  return Array.from({ length: PARTICLE_COUNT }, () => ({
    x,
    y,
    vx: rand(-5, 5),
    vy: rand(-5, 5),
    r: randomChannel(),
    g: randomChannel(),
    b: randomChannel(),
    alpha: 255,
  }));
}

function randomChannel(): number {
  return Math.round(Math.random() * 255);
}
