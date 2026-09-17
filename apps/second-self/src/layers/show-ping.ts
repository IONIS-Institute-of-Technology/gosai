/**
 * Show Ping: server round-trip latency meter, sampled a few times per second
 * with `rt.ping()`.
 */

import type { LayerDeps } from '../shared/deps.js';
import { drawText } from '../shared/draw.js';
import type { Layer } from '../shared/types.js';

const SAMPLE_INTERVAL_MS = 250;
const MAX_SAMPLES = 60;

export function createShowPingLayer(deps: LayerDeps): Layer {
  const samples: number[] = [];
  let lastSample = 0;
  let inFlight = false;
  /** Bumped on every start and stop, so a probe from an earlier run is dropped. */
  let run = 0;

  async function measure(): Promise<void> {
    if (inFlight) return;
    inFlight = true;
    const probeRun = run;
    try {
      const rtt = await deps.rt.ping();
      if (probeRun !== run) return;
      samples.push(rtt);
      if (samples.length > MAX_SAMPLES) samples.shift();
    } catch {
      // A failed probe just leaves a gap.
    } finally {
      inFlight = false;
    }
  }

  return {
    start(): void {
      run += 1;
      samples.length = 0;
      lastSample = 0;
    },

    render({ ctx, timestamp }): void {
      if (timestamp - lastSample > SAMPLE_INTERVAL_MS) {
        lastSample = timestamp;
        void measure();
      }
      const avg = samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length : 0;
      const last = samples.at(-1) ?? 0;
      drawText(ctx, `Ping (avg): ${avg.toFixed(1)} ms`, 40, 80, 36, '#ffffff', 'left', 'middle');
      drawText(
        ctx,
        `Ping (last): ${last.toFixed(1)} ms`,
        40,
        130,
        36,
        'rgba(255,255,255,0.7)',
        'left',
        'middle',
      );
    },

    stop(): void {
      run += 1;
    },
  };
}
