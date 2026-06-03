/**
 * Bounce: keep a falling ball up with your hands.
 *
 * Ports the legacy `bounce` app (components/game.js). A ball falls under
 * gravity and bounces off the walls and off either hand (treated as a paddle
 * whose surface normal follows the wrist->middle-finger axis). The legacy play
 * area is the upper half of the portrait mirror.
 */

import { fillCircle } from '../shared/canvas.js';
import type { LayerDeps } from '../shared/deps.js';
import {
  REF_HEIGHT,
  REF_WIDTH,
  type FrameContext,
  type Landmark,
  type Layer,
} from '../shared/types.js';

const RADIUS = 60;
const GRAVITY = 2000; // px/s^2
const REBOUND = 0.95;
const FLOOR = REF_HEIGHT / 2 - RADIUS;

interface Vec {
  x: number;
  y: number;
}

export function createBounceLayer(deps: LayerDeps): Layer {
  let ball: Vec = { x: REF_WIDTH / 2, y: 60 };
  let speed: Vec = { x: 0, y: 0 };
  let rebounded = false;

  function reset(): void {
    ball = { x: REF_WIDTH / 2, y: 60 };
    speed = { x: 0, y: 0 };
    rebounded = false;
  }

  return {
    start(): void {
      reset();
    },

    render(frame: FrameContext): void {
      const { ctx, deltaMs } = frame;
      const dt = Math.min(deltaMs / 1000, 0.05);

      const prevVy = speed.y;
      speed.y += GRAVITY * dt;
      if (speed.y * prevVy <= 0) rebounded = false;
      ball.x += speed.x * dt;
      ball.y += speed.y * dt;

      if (ball.y > FLOOR) {
        speed.y *= -REBOUND;
        ball.y = FLOOR;
      }
      if (ball.x > REF_WIDTH - RADIUS) {
        speed.x *= -REBOUND * 0.8;
        ball.x = REF_WIDTH - RADIUS;
      }
      if (ball.x < RADIUS) {
        speed.x *= -REBOUND * 0.8;
        ball.x = RADIUS;
      }
      if (ball.y < RADIUS) {
        speed.y *= -REBOUND;
        ball.y = RADIUS;
      }

      const m = deps.feed.mirror.data;
      collide(m.right_hand_pose);
      collide(m.left_hand_pose);

      fillCircle(ctx, ball.x, ball.y, 2 * RADIUS - 30, '#ff3cff');
    },
  };

  function collide(hand: Landmark[]): void {
    if (!hand || hand.length < 13) return;
    let left = REF_WIDTH;
    let right = 0;
    let top = REF_HEIGHT;
    let bottom = 0;
    for (const p of hand) {
      if (!Array.isArray(p) || p.length < 2) continue;
      left = Math.min(left, p[0]!);
      right = Math.max(right, p[0]!);
      top = Math.min(top, p[1]!);
      bottom = Math.max(bottom, p[1]!);
    }
    if (
      ball.x > left - RADIUS &&
      ball.x < right + RADIUS &&
      ball.y > top - RADIUS &&
      ball.y < bottom + RADIUS &&
      !rebounded
    ) {
      const tip = hand[12];
      const wrist = hand[0];
      if (!Array.isArray(tip) || !Array.isArray(wrist)) return;
      let nx: number;
      let ny: number;
      if (tip[0]! > wrist[0]!) {
        nx = -(tip[1]! - wrist[1]!);
        ny = tip[0]! - wrist[0]!;
      } else {
        nx = tip[1]! - wrist[1]!;
        ny = -(tip[0]! - wrist[0]!);
      }
      const denom = nx * nx + ny * ny;
      if (denom < 1e-6) return;
      const projection = (speed.x * nx + speed.y * ny) / denom;
      speed = { x: -speed.x + 2 * projection * nx, y: -speed.y + 2 * projection * ny };
      rebounded = true;
    }
  }
}
