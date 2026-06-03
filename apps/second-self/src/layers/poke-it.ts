/**
 * Poke It: a reflex game.
 *
 * Ports the legacy `poke_it` app (components/game.js). A target appears at a
 * random spot; touch it with either index fingertip to score. A 20s timer
 * resets the round and tracks the best score.
 */

import { drawText, fillCircle, strokeCircle } from '../shared/canvas.js';
import type { LayerDeps } from '../shared/deps.js';
import { isValid } from '../shared/mirror.js';
import { REF_HEIGHT, REF_WIDTH, type FrameContext, type Layer } from '../shared/types.js';

const RADIUS = 60;
const REGION_W = REF_WIDTH * 0.8;
const REGION_H = REF_HEIGHT * 0.5;
const REGION_X = REF_WIDTH * 0.1;
const REGION_Y = 100;
const TIME_LIMIT_S = 20;

export function createPokeItLayer(deps: LayerDeps): Layer {
  let ball = randomBall();
  let count = 0;
  let best = 0;
  let startTime = 0;
  let time = 0;

  function reset(now: number): void {
    if (count > best) best = count;
    count = 0;
    startTime = now;
    ball = randomBall();
  }

  return {
    start(): void {
      count = 0;
      startTime = 0;
      ball = randomBall();
    },

    render(frame: FrameContext): void {
      const { ctx, timestamp } = frame;
      if (startTime === 0) startTime = timestamp;
      time = (timestamp - startTime) / 1000;
      if (time >= TIME_LIMIT_S) reset(timestamp);

      const m = deps.feed.mirror.data;
      const left = m.left_hand_pose[8];
      const right = m.right_hand_pose[8];
      const dLeft = isValid(left) ? dist(ball.x, ball.y, left[0]!, left[1]!) : Infinity;
      const dRight = isValid(right) ? dist(ball.x, ball.y, right[0]!, right[1]!) : Infinity;
      if (Math.min(dLeft, dRight) < RADIUS) {
        count += 1;
        ball = randomBall();
      }

      fillCircle(ctx, ball.x, ball.y, 2 * RADIUS, '#3399ff');
      strokeCircle(ctx, ball.x, ball.y, 2 * RADIUS, 15, '#ffffff');

      drawText(ctx, `Score: ${count}`, REF_WIDTH - 60, 250, 40, '#fff', 'right', 'middle');
      drawText(ctx, `Best: ${best}`, REF_WIDTH - 60, 310, 40, '#fff', 'right', 'middle');

      // Countdown ring.
      ctx.save();
      ctx.translate(REF_WIDTH - 90, 430);
      ctx.rotate(-Math.PI / 2);
      const sweep = (1 - time / TIME_LIMIT_S) * Math.PI * 2;
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, 30, 0, sweep);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    },
  };
}

function randomBall(): { x: number; y: number } {
  return {
    x: REGION_X + Math.random() * REGION_W,
    y: REGION_Y + Math.random() * REGION_H,
  };
}

function dist(x1: number, y1: number, x2: number, y2: number): number {
  return Math.hypot(x1 - x2, y1 - y2);
}
