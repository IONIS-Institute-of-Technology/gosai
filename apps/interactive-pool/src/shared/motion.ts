/**
 * Frame-rate independent motion. The legacy layers moved things by fixed
 * steps each frame at 60 fps; these helpers scale those steps by the real
 * frame time so animations run at the same speed on any display.
 */

/** Length of one legacy frame, in milliseconds. */
export const LEGACY_FRAME_MS = 1000 / 60;

/** How many legacy frames `deltaMs` is worth. */
export function frameSteps(deltaMs: number): number {
  return Math.max(0, deltaMs) / LEGACY_FRAME_MS;
}

/** A per-frame multiplier such as a drag of 0.99, applied over `steps` frames. */
export function decay(perFrame: number, steps: number): number {
  return perFrame ** steps;
}

/** Wraps `value` into `[0, size]`, jumping to the opposite edge when it leaves. */
export function wrap(value: number, size: number): number {
  if (value > size) return 0;
  if (value < 0) return size;
  return value;
}

/** A moving point with a per-frame velocity. */
export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  alpha: number;
}

/**
 * Moves a particle by `steps` frames: position by velocity, then velocity and
 * alpha by their per-frame drag.
 */
export function stepParticle(
  particle: Particle,
  steps: number,
  velocityDrag: number,
  alphaDrag: number,
): void {
  particle.x += particle.vx * steps;
  particle.y += particle.vy * steps;
  particle.vx *= decay(velocityDrag, steps);
  particle.vy *= decay(velocityDrag, steps);
  particle.alpha *= decay(alphaDrag, steps);
}
