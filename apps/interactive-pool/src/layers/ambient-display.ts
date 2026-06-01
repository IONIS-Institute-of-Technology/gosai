/**
 * Ambient display.
 *
 * Background mode: 50 randomly-coloured dots drift across the screen with
 * random velocities, wrapping at edges. Always runs.
 *
 * Reactive mode: when the optional `sensor_server` driver is available and
 * emits movements, any distance reading below the threshold triggers a
 * firework burst. Bursts cap out at 6 concurrent ones and fade out via
 * particle drag + alpha decay. If the driver is not installed the layer
 * simply runs as a passive ambient drift.
 */

import type { DriverSubscription } from '@gosai/sdk';
import { REF_HEIGHT, REF_WIDTH, type FrameContext, type Layer } from '../shared/types.js';
import { rand } from '../shared/math.js';
import type { PoolFeed } from '../shared/feed.js';

const DOT_COUNT = 50;
const DIST_THRESHOLD = 50;
const MAX_FIREWORKS = 6;
const PARTICLE_COUNT = 100;
const VEL_DRAG = 0.991;
const ALPHA_DRAG = 0.99;
const FIRE_REFRACTORY_MS = 3000;

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

/**
 * Minimal subset of the SDK driver client we depend on. Decoupling lets
 * tests / future runtimes plug in their own subscription source.
 */
export interface DriverSource {
  on(driver: string, event: string, listener: (data: unknown) => void): DriverSubscription;
}

export function createAmbientDisplayLayer(_feed: PoolFeed, drivers: DriverSource): Layer {
  let dots: Dot[] = [];
  let fireworks: Firework[] = [];
  let lastFireAt = 0;
  let belowThreshold = false;
  let sub: DriverSubscription | null = null;

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

  function handleMovements(data: unknown): void {
    if (typeof data !== 'object' || data === null) return;
    // sensor_server `movements` legacy payload: an object whose values are
    // distance readings. We treat any value below the threshold as a fire
    // trigger.
    const values = Object.values(data as Record<string, unknown>).filter(
      (v): v is number => typeof v === 'number',
    );
    if (values.length === 0) return;
    const anyBelow = values.some((v) => v < DIST_THRESHOLD);
    if (anyBelow && !belowThreshold) {
      // Edge-trigger: only spawn a firework on the descending edge.
      belowThreshold = true;
      const now = performance.now();
      if (now - lastFireAt > FIRE_REFRACTORY_MS || fireworks.length === 0) {
        maybeSpawnFirework(now);
      }
    } else if (!anyBelow) {
      belowThreshold = false;
    }
  }

  return {
    start(): void {
      initDots();
      fireworks = [];
      lastFireAt = 0;
      belowThreshold = false;
      try {
        sub = drivers.on('sensor_server', 'movements', handleMovements);
      } catch {
        // Driver not registered -- layer keeps running as passive drift.
        sub = null;
      }
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
      try {
        sub?.unsubscribe();
      } catch {
        // best-effort.
      }
      sub = null;
      dots = [];
      fireworks = [];
    },
  };
}
