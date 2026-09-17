/**
 * Live ball-position relay.
 *
 * Draws nothing. Streams normalised ball positions to the WebSocket in the
 * `live.url` setting each time the ball driver reports new ones, and stays
 * idle while the setting is empty.
 *
 * - Follows the setting while running: a new URL closes the old socket and
 *   connects to the new one.
 * - Reconnects after a close or error with exponential back-off, capped at 30 s.
 * - `stop()` closes the socket and cancels a pending reconnect.
 */

import type { ExperienceRuntimeContext } from '@gosai/sdk';
import { relayUrlProblem, type PoolSettings } from '../settings.js';
import { REF_HEIGHT, REF_WIDTH, type PoolFrame, type PoolLayer } from '../shared/types.js';

const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

export function createLiveLayer(
  rt: ExperienceRuntimeContext,
  settings: () => PoolSettings,
): PoolLayer {
  /** The URL the relay follows, once it passed `relayUrlProblem`. */
  let target = '';
  /** The last `live.url` value seen, valid or not. */
  let seenUrl: string | null = null;
  let socket: WebSocket | null = null;
  let backoff = MIN_BACKOFF_MS;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let lastSentAt = 0;
  let running = false;

  function disconnect(): void {
    if (reconnectTimer !== null) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    const current = socket;
    socket = null;
    current?.close();
  }

  function scheduleReconnect(): void {
    if (!running || target === '' || reconnectTimer !== null) return;
    const delay = backoff;
    backoff = Math.min(MAX_BACKOFF_MS, backoff * 2);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function connect(): void {
    if (!running || target === '') return;
    let opened: WebSocket;
    try {
      opened = new WebSocket(target);
    } catch (err) {
      rt.log.warn('live: could not open the relay socket', { url: target, err: String(err) });
      scheduleReconnect();
      return;
    }
    socket = opened;
    opened.addEventListener('open', () => {
      backoff = MIN_BACKOFF_MS;
      rt.log.info('live: connected', { url: target });
    });
    opened.addEventListener('close', () => {
      // A socket replaced by a new URL or closed by stop() doesn't reconnect.
      if (socket !== opened) return;
      socket = null;
      scheduleReconnect();
    });
  }

  /** Reconnects when the `live.url` setting changed. */
  function follow(): void {
    const url = settings().live.url;
    if (url === seenUrl) return;
    seenUrl = url;
    disconnect();
    backoff = MIN_BACKOFF_MS;
    target = '';
    if (url === '') {
      rt.log.info('live: relay off (set live.url in the app settings to stream ball positions)');
      return;
    }
    const problem = relayUrlProblem(url, rt.app.manifest.network?.connect ?? []);
    if (problem) {
      rt.log.warn(`live: ${problem}`);
      return;
    }
    target = url;
    connect();
  }

  return {
    start(): void {
      running = true;
      seenUrl = null;
      follow();
    },

    render({ tracking }: PoolFrame): void {
      follow();
      if (socket?.readyState !== WebSocket.OPEN) return;
      // Only send when the ball driver reported since the last message.
      if (tracking.ballsUpdatedAt === lastSentAt) return;
      lastSentAt = tracking.ballsUpdatedAt;
      socket.send(
        JSON.stringify({
          ts: Date.now(),
          balls: tracking.balls.map((b) => ({ x: b.x / REF_WIDTH, y: b.y / REF_HEIGHT })),
        }),
      );
    },

    stop(): void {
      running = false;
      disconnect();
    },
  };
}
