/**
 * Poke It: a reflex game.
 *
 * Ports the legacy `poke_it` app (components/game.js). A target appears at a
 * random spot; touch it with either index fingertip to score. A 20s timer
 * resets the round and tracks the best score.
 */

import type { LayerDeps } from '../shared/deps.js';
import { drawText, fillCircle, strokeCircle } from '../shared/draw.js';
import { isValid } from '../shared/mirror.js';
import { REF_HEIGHT, REF_WIDTH, type Layer } from '../shared/types.js';
import { dist, drawProgressRing } from '../shared/ui.js';

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

    render({ ctx, timestamp }): void {
      if (startTime === 0) startTime = timestamp;
      const time = (timestamp - startTime) / 1000;
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

      drawProgressRing(ctx, REF_WIDTH - 90, 430, 30, 1 - time / TIME_LIMIT_S, {
        color: '#fff',
        fill: true,
      });
    },
  };
}

function randomBall(): { x: number; y: number } {
  return {
    x: REGION_X + Math.random() * REGION_W,
    y: REGION_Y + Math.random() * REGION_H,
  };
}
