/**
 * Show Ping: server round-trip latency meter.
 *
 * Ports the legacy `show_ping` app. The legacy version bounced a socket message
 * off the server; here we time a `drivers.get` request/response round-trip
 * through the SDK WebSocket, sampling a few times per second.
 */

import { drawText } from '../shared/canvas.js';
import type { LayerDeps } from '../shared/deps.js';
import { type FrameContext, type Layer } from '../shared/types.js';

const SAMPLE_INTERVAL_MS = 250;
const MAX_SAMPLES = 60;

export function createShowPingLayer(deps: LayerDeps): Layer {
  const samples: number[] = [];
  let lastSample = 0;
  let inFlight = false;
  let stopped = false;

  async function measure(): Promise<void> {
    if (inFlight) return;
    inFlight = true;
    const t0 = performance.now();
    try {
      await deps.rt.drivers.get('pose_to_mirror', 'mirrored_data');
      if (stopped) return;
      const rtt = performance.now() - t0;
      samples.push(rtt);
      if (samples.length > MAX_SAMPLES) samples.shift();
    } catch {
      // ignore failed probes.
    } finally {
      inFlight = false;
    }
  }

  return {
    start(): void {
      stopped = false;
      samples.length = 0;
    },

    render({ ctx, timestamp }: FrameContext): void {
      if (timestamp - lastSample > SAMPLE_INTERVAL_MS) {
        lastSample = timestamp;
        void measure();
      }
      const avg = samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length : 0;
      const last = samples.length ? samples[samples.length - 1]! : 0;
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
      stopped = true;
    },
  };
}
