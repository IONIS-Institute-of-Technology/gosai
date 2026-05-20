/**
 * Cue overlay layer.
 *
 * Draws a white line between the two cue endpoints when the cue is detected.
 * Legacy line weight was 10 reference-space pixels.
 */

import type { FrameContext, Layer } from '../shared/types.js';
import { strokeLine } from '../shared/canvas-utils.js';
import type { PoolFeed } from '../shared/feed.js';

const CUE_STROKE = 10;
const CUE_COLOR = '#ffffff';

export function createCueLayer(feed: PoolFeed): Layer {
  return {
    render(frame: FrameContext): void {
      const { cue } = feed.cue;
      if (!cue.detected) return;
      strokeLine(frame.ctx, cue.a.x, cue.a.y, cue.b.x, cue.b.y, CUE_STROKE, CUE_COLOR);
    },
  };
}
