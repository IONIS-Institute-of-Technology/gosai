/**
 * Setup text: the title, the canvas frame rate and the ball detection rate,
 * each shown when its `debug.*` setting is on. The title and ball rate are
 * turned 180 degrees to read from the projector side, as in the legacy app.
 */

import type { PoolSettings } from '../settings.js';
import { drawText } from '../shared/draw.js';
import { REF_HEIGHT, REF_WIDTH, type PoolFrame, type PoolLayer } from '../shared/types.js';

/** How often the frame rate read-out refreshes. */
const FPS_WINDOW_MS = 500;

export function createDebugLayer(settings: () => PoolSettings): PoolLayer {
  let renderFps = 0;
  let windowMs = 0;
  let windowFrames = 0;

  return {
    render({ ctx, deltaMs, tracking }: PoolFrame): void {
      windowMs += deltaMs;
      windowFrames += 1;
      if (windowMs >= FPS_WINDOW_MS) {
        renderFps = (windowFrames * 1000) / windowMs;
        windowMs = 0;
        windowFrames = 0;
      }

      const { debug } = settings();
      if (debug.title) {
        drawText(ctx, 'INTERACTIVE POOL PROJECT', REF_WIDTH / 2, REF_HEIGHT - 30, {
          fontPx: 36,
          bold: true,
          color: '#ffffff',
          align: 'center',
          baseline: 'middle',
          rotated: true,
        });
      }
      if (debug.ballFps) {
        drawText(
          ctx,
          `Ball detection : ${Math.round(tracking.ballFps)} FPS`,
          REF_WIDTH - 300,
          REF_HEIGHT - 30,
          { fontPx: 32, color: '#ffffff', align: 'center', baseline: 'middle', rotated: true },
        );
      }
      if (debug.renderFps) {
        drawText(ctx, `render ${renderFps.toFixed(0)} fps`, 24, 36, {
          fontPx: 24,
          color: '#9ca3af',
        });
      }
    },
  };
}
