/**
 * Show Frequency: live microphone spectrum + dominant pitch.
 *
 * Ports the legacy `show_frequency` app. Reads the `frequency_analysis` feed and
 * draws the rFFT magnitudes as a spectrum rising from the bottom edge, with the
 * dominant frequency printed in the center.
 */

import { drawText, strokeLine } from '../shared/canvas.js';
import type { LayerDeps } from '../shared/deps.js';
import { REF_HEIGHT, REF_WIDTH, type FrameContext, type Layer } from '../shared/types.js';

export function createShowFrequencyLayer(deps: LayerDeps): Layer {
  return {
    render({ ctx }: FrameContext): void {
      const f = deps.feed.frequency.data;
      const rfft = f.rfft;

      if (rfft.length > 0) {
        const mul = REF_WIDTH / rfft.length;
        ctx.strokeStyle = 'rgba(120,200,255,0.9)';
        ctx.lineWidth = Math.max(1, mul * 0.8);
        for (let i = 0; i < rfft.length; i++) {
          const h = Math.min(10 * rfft[i]!, REF_HEIGHT * 0.85);
          strokeLine(
            ctx,
            i * mul,
            REF_HEIGHT,
            i * mul,
            REF_HEIGHT - h,
            ctx.lineWidth,
            ctx.strokeStyle,
          );
        }
      }

      drawText(
        ctx,
        `${Math.round(f.max_frequency)} Hz`,
        REF_WIDTH / 2,
        REF_HEIGHT / 2,
        64,
        '#ffffff',
        'center',
        'middle',
      );
    },
  };
}
