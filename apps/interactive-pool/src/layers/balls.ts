/**
 * Ball overlay layer.
 *
 * Renders a white circle outline around every detected ball. The legacy
 * value of `r = 80` is p5's *diameter* parameter, so we draw a circle of
 * 80 reference-space pixels (~40 px radius).
 *
 * Also renders the ball-driver FPS read-out (rotated 180 degrees to match
 * the legacy projector orientation).
 */

import { REF_HEIGHT, REF_WIDTH, type FrameContext, type Layer } from '../shared/types.js';
import { drawRotatedText, strokeCircle } from '../shared/canvas-utils.js';
import type { PoolFeed } from '../shared/feed.js';

const BALL_DIAMETER = 80;
const BALL_STROKE = 8;
const BALL_COLOR = '#ffffff';

export function createBallsLayer(feed: PoolFeed): Layer {
  return {
    render(frame: FrameContext): void {
      const { ctx } = frame;
      for (const ball of feed.balls.balls) {
        strokeCircle(ctx, ball.x, ball.y, ball.r || BALL_DIAMETER, BALL_STROKE, BALL_COLOR);
      }

      // Detection FPS read-out, mirrored to the bottom-right of the legacy
      // projector orientation.
      const fps = Math.round(feed.balls.fps);
      const label = `Ball detection : ${fps} FPS`;
      drawRotatedText(
        ctx,
        label,
        REF_WIDTH / 2 + 400,
        REF_HEIGHT + 10,
        32,
        '#ffffff',
        'center',
        'alphabetic',
      );
    },
  };
}
