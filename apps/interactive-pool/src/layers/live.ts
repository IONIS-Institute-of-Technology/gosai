/**
 * Live ball-position relay.
 *
 * Headless layer (no visual rendering) that forwards normalised ball
 * positions to an external WebSocket every time the ball feed updates. The
 * relay URL lives in app storage under the key `live_server_url`; if blank
 * or unset the layer stays dormant.
 *
 * Lifecycle:
 *   - On `start()`, reads the URL from storage and opens the socket.
 *   - On socket close / error, schedules a reconnect with exponential
 *     back-off (capped at 30s). Never throws on its own.
 *   - On `stop()`, closes the socket and cancels any pending reconnect.
 */

import type { ExperienceRuntimeContext } from '@gosai/sdk';
import { REF_HEIGHT, REF_WIDTH, type FrameContext, type Layer } from '../shared/types.js';
import type { PoolFeed } from '../shared/feed.js';

const STORAGE_KEY = 'live_server_url';
const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

export function createLiveLayer(feed: PoolFeed, rt: ExperienceRuntimeContext): Layer {
  let url: string | null = null;
  let socket: WebSocket | null = null;
  let backoff = MIN_BACKOFF_MS;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let lastSentAt = 0;
  let stopped = false;

  function scheduleReconnect(): void {
    if (stopped || url === null || url === '') return;
    if (reconnectTimer !== null) return;
    const delay = backoff;
    backoff = Math.min(MAX_BACKOFF_MS, backoff * 2);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function connect(): void {
    if (stopped || url === null || url === '') return;
    try {
      socket = new WebSocket(url);
    } catch (err) {
      rt.log.warn('live: failed to open WebSocket', {
        err: String((err as Error)?.message ?? err),
      });
      socket = null;
      scheduleReconnect();
      return;
    }

    socket.addEventListener('open', () => {
      backoff = MIN_BACKOFF_MS;
      rt.log.info('live: connected', { url });
    });
    socket.addEventListener('error', () => {
      rt.log.warn('live: socket error');
    });
    socket.addEventListener('close', () => {
      socket = null;
      if (!stopped) scheduleReconnect();
    });
  }

  return {
    async start(): Promise<void> {
      stopped = false;
      try {
        const stored = await rt.storage.get<string>(STORAGE_KEY, '');
        url = typeof stored === 'string' && stored.length > 0 ? stored : null;
      } catch {
        url = null;
      }
      if (url === null) {
        rt.log.info('live: relay disabled (set live_server_url in storage to enable)');
        return;
      }
      connect();
    },

    render(_frame: FrameContext): void {
      if (socket === null || socket.readyState !== WebSocket.OPEN) return;
      // Only send when the feed has fresh data since the last broadcast.
      if (feed.balls.lastUpdate === lastSentAt) return;
      lastSentAt = feed.balls.lastUpdate;
      const payload = {
        ts: Date.now(),
        balls: feed.balls.balls.map((b) => ({
          x: b.x / REF_WIDTH,
          y: b.y / REF_HEIGHT,
        })),
      };
      try {
        socket.send(JSON.stringify(payload));
      } catch {
        // best-effort; the close handler will reconnect.
      }
    },

    stop(): void {
      stopped = true;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (socket !== null) {
        try {
          socket.close();
        } catch {
          // best-effort.
        }
        socket = null;
      }
    },
  };
}
