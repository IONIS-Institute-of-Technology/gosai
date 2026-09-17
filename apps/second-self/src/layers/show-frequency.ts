/**
 * Show Frequency: live microphone spectrum and dominant pitch.
 *
 * Draws the `frequency_analysis` rFFT magnitudes as a spectrum rising from the
 * bottom edge, with the dominant frequency printed in the center.
 */

import type { LayerDeps } from '../shared/deps.js';
import { drawText } from '../shared/draw.js';
import { REF_HEIGHT, REF_WIDTH, type Layer } from '../shared/types.js';

export function createShowFrequencyLayer(deps: LayerDeps): Layer {
  return {
    render({ ctx }): void {
      const { rfft, max_frequency } = deps.feed.frequency.data;

      if (rfft.length > 0) {
        const step = REF_WIDTH / rfft.length;
        ctx.beginPath();
        for (let i = 0; i < rfft.length; i++) {
          const x = i * step;
          ctx.moveTo(x, REF_HEIGHT);
          ctx.lineTo(x, REF_HEIGHT - Math.min(10 * rfft[i]!, REF_HEIGHT * 0.85));
        }
        ctx.strokeStyle = 'rgba(120,200,255,0.9)';
        ctx.lineWidth = Math.max(1, step * 0.8);
        ctx.stroke();
      }

      drawText(
        ctx,
        `${Math.round(max_frequency)} Hz`,
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
