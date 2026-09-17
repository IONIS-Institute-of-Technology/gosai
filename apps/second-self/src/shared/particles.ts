/**
 * A small rising-particle system for the theremine and music-training
 * layers. Particles drift sideways, accelerate upward and fade over their
 * lifespan. Motion follows elapsed time, so it looks the same at any frame
 * rate.
 */

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export interface Particle {
  x: number;
  y: number;
  /** px/s */
  vx: number;
  /** px/s, negative is up. */
  vy: number;
  /** Remaining life in ms. */
  life: number;
  color: RGB;
}

/** Upward acceleration in px/s². */
const RISE_ACCELERATION = 180;
/** Largest sideways speed in px/s. */
const MAX_DRIFT = 12;

/**
 * Advances one particle by `deltaMs`. Returns false once it has died. The
 * velocity is integrated exactly, so the result doesn't depend on how the
 * elapsed time is split into frames.
 */
export function stepParticle(p: Particle, deltaMs: number): boolean {
  const dt = deltaMs / 1000;
  p.x += p.vx * dt;
  p.y += p.vy * dt - 0.5 * RISE_ACCELERATION * dt * dt;
  p.vy -= RISE_ACCELERATION * dt;
  p.life -= deltaMs;
  return p.life > 0;
}

export class ParticleSystem {
  private particles: Particle[] = [];

  constructor(private readonly lifeMs: number) {}

  private add(x: number, y: number, color: RGB): void {
    this.particles.push({
      x,
      y,
      vx: (Math.random() * 2 - 1) * MAX_DRIFT,
      vy: 0,
      life: this.lifeMs,
      color,
    });
  }

  /** Adds a particle with the probability that gives `perSecond` particles on average. */
  emit(x: number, y: number, color: RGB, perSecond: number, deltaMs: number): void {
    if (Math.random() < (perSecond * deltaMs) / 1000) this.add(x, y, color);
  }

  clear(): void {
    this.particles.length = 0;
  }

  /** Advances every particle by `deltaMs` and draws the ones still alive. */
  run(ctx: CanvasRenderingContext2D, deltaMs: number): void {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i]!;
      if (!stepParticle(p, deltaMs)) {
        this.particles.splice(i, 1);
        continue;
      }
      ctx.fillStyle = `rgba(${p.color.r},${p.color.g},${p.color.b},${p.life / this.lifeMs})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}
