/**
 * Ambient display.
 *
 * Background mode: 50 randomly-coloured dots drift across the screen with
 * random velocities, wrapping at edges. Always runs.
 *
 * Firework bursts spawn periodically while the layer runs. Bursts cap out at
 * 6 concurrent ones and fade out via particle drag + alpha decay.
 */

import { REF_HEIGHT, REF_WIDTH, type FrameContext, type Layer } from '../shared/types.js';
import { rand } from '../shared/math.js';
import type { PoolFeed } from '../shared/feed.js';

const DOT_COUNT = 50;
const MAX_FIREWORKS = 6;
const PARTICLE_COUNT = 100;
const VEL_DRAG = 0.991;
const ALPHA_DRAG = 0.99;
const FIRE_INTERVAL_MS = 3000;

interface Dot {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  g: number;
  b: number;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  g: number;
  b: number;
  alpha: number;
}

interface Firework {
  particles: Particle[];
}

export function createAmbientDisplayLayer(_feed: PoolFeed): Layer {
  let dots: Dot[] = [];
  let fireworks: Firework[] = [];
  let lastFireAt = 0;

  function initDots(): void {
    dots = [];
    for (let i = 0; i < DOT_COUNT; i++) {
      dots.push({
        x: rand(0, REF_WIDTH),
        y: rand(0, REF_HEIGHT),
        vx: rand(-2, 2),
        vy: rand(-2, 2),
        r: Math.random() * 255,
        g: Math.random() * 255,
        b: Math.random() * 255,
      });
    }
  }

  function maybeSpawnFirework(now: number): void {
    if (fireworks.length >= MAX_FIREWORKS) return;
    if (now - lastFireAt < 200) return;
    lastFireAt = now;
    const x = rand(REF_WIDTH * 0.1, REF_WIDTH * 0.9);
    const y = rand(REF_HEIGHT * 0.1, REF_HEIGHT * 0.9);
    const particles: Particle[] = [];
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      particles.push({
        x,
        y,
        vx: rand(-5, 5),
        vy: rand(-5, 5),
        r: Math.random() * 255,
        g: Math.random() * 255,
        b: Math.random() * 255,
        alpha: 255,
      });
    }
    fireworks.push({ particles });
  }

  return {
    start(): void {
      initDots();
      fireworks = [];
      lastFireAt = 0;
    },

    render(frame: FrameContext): void {
      const { ctx } = frame;

      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, REF_WIDTH, REF_HEIGHT);

      // Drift dots.
      for (const dot of dots) {
        dot.x += dot.vx;
        dot.y += dot.vy;
        if (dot.x > REF_WIDTH) dot.x = 0;
        if (dot.x < 0) dot.x = REF_WIDTH;
        if (dot.y > REF_HEIGHT) dot.y = 0;
        if (dot.y < 0) dot.y = REF_HEIGHT;
        ctx.fillStyle = `rgb(${Math.round(dot.r)},${Math.round(dot.g)},${Math.round(dot.b)})`;
        ctx.fillRect(dot.x - 3.5, dot.y - 3.5, 7, 7);
      }
      if (frame.timestamp - lastFireAt > FIRE_INTERVAL_MS) {
        maybeSpawnFirework(frame.timestamp);
      }

      // Fireworks.
      fireworks = fireworks.filter((fw) => fw.particles.some((p) => p.alpha > 2));
      for (const fw of fireworks) {
        for (const p of fw.particles) {
          if (p.alpha <= 1) continue;
          ctx.fillStyle = `rgba(${Math.round(p.r)},${Math.round(p.g)},${Math.round(p.b)},${(p.alpha / 255).toFixed(3)})`;
          ctx.beginPath();
          ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
          ctx.fill();
          p.x += p.vx;
          p.y += p.vy;
          p.vx *= VEL_DRAG;
          p.vy *= VEL_DRAG;
          p.alpha *= ALPHA_DRAG;
        }
      }
    },

    stop(): void {
      dots = [];
      fireworks = [];
    },
  };
}
