/**
 * Rabbits game.
 *
 * Six rabbit characters wander across the table from left to right. When a
 * detected ball collides with one, the rabbit "dies" (firework burst, ghost
 * silhouette fades) and respawns after 3 seconds at the left edge.
 *
 * Faithful port of the legacy rabbit/firework/particles drawing code,
 * translated to Canvas2D. Coordinate space is reference (1920x1080).
 */

import { REF_HEIGHT, REF_WIDTH, type FrameContext, type Layer } from '../shared/types.js';
import { fillCircle, fillEllipse, strokeLine } from '../shared/canvas-utils.js';
import { dist, pick, rand } from '../shared/math.js';
import type { PoolFeed } from '../shared/feed.js';

const RABBIT_COUNT = 6;
const RABBIT_MIN_R = 40;
const RABBIT_MAX_R = 60;
const RESPAWN_DELAY_MS = 3000;
const Y_SPEED_CHOICES = [-2.5, -2.2, -1, 1, 2.2, 2.5];

const BALL_DIAMETER_FOR_COLLISION = 80;

const FIREWORK_PARTICLES = 100;
const PARTICLE_DRAG = 0.98;

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

interface Rabbit {
  x: number;
  y: number;
  r: number;
  xSpeed: number;
  ySpeed: number;
  angle: number;
  alpha: number;
  alive: boolean;
  deathTime: number;
  particles: Particle[];
}

export function createRabbitsLayer(feed: PoolFeed): Layer {
  let rabbits: Rabbit[] = [];

  function spawn(): Rabbit {
    return {
      x: 0,
      y: rand(0, REF_HEIGHT),
      r: rand(RABBIT_MIN_R, RABBIT_MAX_R),
      xSpeed: rand(2, 2.5),
      ySpeed: pick(Y_SPEED_CHOICES),
      angle: 0,
      alpha: 255,
      alive: true,
      deathTime: 0,
      particles: [],
    };
  }

  function makeParticles(x: number, y: number): Particle[] {
    const out: Particle[] = [];
    for (let i = 0; i < FIREWORK_PARTICLES; i++) {
      out.push({
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
    return out;
  }

  return {
    start(): void {
      rabbits = [];
      for (let i = 0; i < RABBIT_COUNT; i++) {
        rabbits.push(spawn());
      }
    },

    render(frame: FrameContext): void {
      const now = frame.timestamp;

      // Collision: any ball touching an alive rabbit kills it. We use ball
      // diameter from the legacy balls layer (80) for the radius sum.
      for (const rabbit of rabbits) {
        if (!rabbit.alive) continue;
        for (const ball of feed.balls.balls) {
          const sumR = rabbit.r / 2 + (ball.r || BALL_DIAMETER_FOR_COLLISION) / 2;
          if (dist({ x: ball.x, y: ball.y }, { x: rabbit.x, y: rabbit.y }) < sumR) {
            rabbit.alive = false;
            rabbit.deathTime = now;
            rabbit.particles = makeParticles(rabbit.x, rabbit.y);
            rabbit.alpha = 255;
            break;
          }
        }
      }

      // Respawn dead rabbits after the delay.
      for (const rabbit of rabbits) {
        if (!rabbit.alive && now - rabbit.deathTime >= RESPAWN_DELAY_MS) {
          rabbit.x = 0;
          rabbit.y = rand(0, REF_HEIGHT);
          rabbit.alive = true;
          rabbit.alpha = 255;
          rabbit.particles = [];
        }
      }

      // Move and draw each rabbit.
      for (const rabbit of rabbits) {
        moveRabbit(rabbit);
        drawRabbit(frame.ctx, rabbit);
      }
    },

    stop(): void {
      rabbits = [];
    },
  };
}

// ---------------------------------------------------------------------------
// Motion
// ---------------------------------------------------------------------------

function moveRabbit(rabbit: Rabbit): void {
  if (rabbit.alive) {
    rabbit.x += rabbit.xSpeed;
    rabbit.y += rabbit.ySpeed;
    if (rabbit.x > REF_WIDTH) rabbit.x = 0;
    if (rabbit.y > REF_HEIGHT) rabbit.ySpeed = -rabbit.ySpeed;
    if (rabbit.y < 0) rabbit.ySpeed = -rabbit.ySpeed;
    if (rabbit.x < 0) rabbit.x = REF_WIDTH;
  }
  // Dead rabbits stay put in legacy (speeds were zeroed); we follow that.
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

function drawRabbit(ctx: CanvasRenderingContext2D, rabbit: Rabbit): void {
  if (rabbit.alive) {
    drawAliveRabbit(ctx, rabbit);
    rabbit.angle += 0.025;
  } else {
    drawFirework(ctx, rabbit);
    drawGhostRabbit(ctx, rabbit);
    rabbit.alpha = Math.max(0, rabbit.alpha - 0.5);
  }
}

const GREEN = '#adff2f'; // 173, 255, 47
const DARK_GREEN = '#50c878'; // 80, 200, 120
const WHITE = '#ffffff';
const BLACK = '#000000';

function drawAliveRabbit(ctx: CanvasRenderingContext2D, r: Rabbit): void {
  ctx.save();
  ctx.translate(r.x, r.y);
  ctx.rotate(r.angle);

  // Body / snout.
  fillCircle(ctx, 0, 0, 70, GREEN);
  fillEllipse(ctx, 0, 8, 82, 50, GREEN);

  // Ears.
  ctx.save();
  ctx.rotate(Math.PI / 2.5);
  fillEllipse(ctx, -35, 0, 72, 25, GREEN);
  fillEllipse(ctx, -45, 0, 32, 15, DARK_GREEN);
  ctx.restore();

  ctx.save();
  ctx.rotate(-Math.PI / 2.5);
  fillEllipse(ctx, 35, 0, 72, 25, GREEN);
  fillEllipse(ctx, 45, 0, 32, 15, DARK_GREEN);
  ctx.restore();

  // Teeth.
  ctx.fillStyle = WHITE;
  ctx.fillRect(-6, 23, 5, 15);
  ctx.fillRect(1, 23, 5, 15);

  // Eyes (outline + filled black + small white highlight).
  ctx.strokeStyle = BLACK;
  ctx.lineWidth = 1;
  strokeEllipse(ctx, -7, -10, 10, 20);
  strokeEllipse(ctx, 7, -10, 10, 20);
  fillEllipse(ctx, -7, -5, 8, 10, BLACK);
  fillEllipse(ctx, 7, -5, 8, 10, BLACK);

  // Nose.
  fillEllipse(ctx, 0, 8, 8, 5, BLACK);
  strokeLine(ctx, 0, 8, 0, 18, 1, BLACK);

  // Eye highlights.
  fillCircle(ctx, -9, -8, 2, WHITE);
  fillCircle(ctx, 5, -8, 2, WHITE);

  // Smile (arc).
  ctx.strokeStyle = BLACK;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.ellipse(0, 15, 9, 6, 0, 0.1 * Math.PI, 0.9 * Math.PI);
  ctx.stroke();

  // Whiskers.
  ctx.strokeStyle = BLACK;
  ctx.lineWidth = 1;
  whisker(ctx, -45, -3, -22, 5);
  whisker(ctx, -45, 10, -22, 10);
  whisker(ctx, -45, 25, -22, 15);
  whisker(ctx, 45, -3, 22, 5);
  whisker(ctx, 45, 10, 22, 10);
  whisker(ctx, 45, 25, 22, 15);

  ctx.restore();
}

function whisker(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

function strokeEllipse(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  ctx.beginPath();
  ctx.ellipse(x, y, w / 2, h / 2, 0, 0, Math.PI * 2);
  ctx.stroke();
}

function drawGhostRabbit(ctx: CanvasRenderingContext2D, r: Rabbit): void {
  const alpha = Math.max(0, r.alpha) / 255;
  if (alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(r.x, r.y);
  ctx.scale(2, 2);

  // Body, head.
  ctx.fillStyle = '#d3d3d3';
  ctx.fillRect(-10, 11, 20, 15);
  ctx.beginPath();
  ctx.arc(0, 0, 20, 0, Math.PI * 2);
  ctx.fill();

  // Eyes.
  fillCircle(ctx, -7, -1, 10, BLACK);
  fillCircle(ctx, 7, -1, 10, BLACK);

  // Feet.
  ctx.fillStyle = BLACK;
  ctx.fillRect(-4, 18, 3, 9);
  ctx.fillRect(2, 18, 3, 9);

  ctx.restore();
}

function drawFirework(ctx: CanvasRenderingContext2D, r: Rabbit): void {
  if (r.particles.length === 0) return;
  ctx.save();
  for (const p of r.particles) {
    if (p.alpha <= 1) continue;
    ctx.fillStyle = `rgba(${Math.round(p.r)},${Math.round(p.g)},${Math.round(p.b)},${(p.alpha / 255).toFixed(3)})`;
    ctx.fillRect(p.x - 1, p.y - 1, 2, 2);
    // Update.
    p.x += p.vx;
    p.y += p.vy;
    p.vx *= PARTICLE_DRAG;
    p.vy *= PARTICLE_DRAG;
    p.alpha *= PARTICLE_DRAG;
  }
  ctx.restore();
}
