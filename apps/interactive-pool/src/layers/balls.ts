/**
 * Ball overlay: a white circle around every detected ball.
 *
 * To keep motion smooth on low-FPS cameras (e.g. 15 Hz) each ball's position
 * is extrapolated from its velocity (px/s) and the time since the detection
 * arrived. Extrapolation is capped so a ball that stops or changes direction
 * never overshoots noticeably.
 */

import { strokeCircle } from '../shared/draw.js';
import type { PoolFrame, PoolLayer } from '../shared/types.js';

const BALL_STROKE = 8;
const BALL_COLOR = '#ffffff';
/** Cap extrapolation so a sudden stop doesn't produce a visible overshoot. */
const MAX_EXTRAPOLATION_MS = 120;

export function createBallsLayer(): PoolLayer {
  return {
    render({ ctx, timestamp, tracking }: PoolFrame): void {
      const elapsedMs = Math.min(
        MAX_EXTRAPOLATION_MS,
        Math.max(0, timestamp - tracking.ballsUpdatedAt),
      );
      const dt = elapsedMs / 1000;
      for (const ball of tracking.balls) {
        strokeCircle(
          ctx,
          ball.x + ball.vx * dt,
          ball.y + ball.vy * dt,
          ball.diameter,
          BALL_STROKE,
          BALL_COLOR,
        );
      }
    },
  };
}
