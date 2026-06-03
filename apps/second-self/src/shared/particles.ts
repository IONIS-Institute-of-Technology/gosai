/**
 * Tiny rising-particle system, ported from the theremine/music-training
 * sketches. Particles drift upward and fade over their lifespan.
 */

export interface RGB {
  r: number;
  g: number;
  b: number;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  color: RGB;
}

export class ParticleSystem {
  private particles: Particle[] = [];

  constructor(private readonly maxLife = 200) {}

  add(x: number, y: number, color: RGB): void {
    this.particles.push({
      x,
      y,
      vx: (Math.random() - 0.5) * 0.4,
      vy: 0,
      life: this.maxLife,
      color,
    });
  }

  clear(): void {
    this.particles.length = 0;
  }

  run(ctx: CanvasRenderingContext2D): void {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i]!;
      p.vy += -0.05;
      p.x += p.vx;
      p.y += p.vy;
      p.life -= 1;
      if (p.life < 0) {
        this.particles.splice(i, 1);
        continue;
      }
      ctx.fillStyle = `rgba(${p.color.r},${p.color.g},${p.color.b},${Math.max(0, p.life / this.maxLife)})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}
