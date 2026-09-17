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
 *   Each failed attempt logs a warning, so the back-off also limits the logs.
 * - `stop()` closes the socket and cancels a pending reconnect.
 */

import type { ExperienceRuntimeContext } from '@gosai/sdk';
import { relayUrlProblem, type PoolSettings } from '../settings.js';
import { REF_HEIGHT, REF_WIDTH, type PoolFrame, type PoolLayer } from '../shared/types.js';

export const MIN_BACKOFF_MS = 1_000;
export const MAX_BACKOFF_MS = 30_000;

/** `WebSocket.OPEN`. */
const OPEN = 1;

/** The parts of a WebSocket the relay uses. */
export interface RelaySocket {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: 'open' | 'close', listener: () => void): void;
}

/** How the relay opens sockets and waits. Tests replace them. */
export interface LiveEnvironment {
  readonly openSocket: (url: string) => RelaySocket;
  readonly setTimer: (callback: () => void, ms: number) => unknown;
  readonly clearTimer: (timer: unknown) => void;
}

const BROWSER: LiveEnvironment = {
  openSocket: (url) => new WebSocket(url),
  setTimer: (callback, ms) => setTimeout(callback, ms),
  clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

export function createLiveLayer(
  rt: ExperienceRuntimeContext,
  settings: () => PoolSettings,
  env: LiveEnvironment = BROWSER,
): PoolLayer {
  /** The URL the relay follows, once it passed `relayUrlProblem`. */
  let target = '';
  /** The last `live.url` value seen, valid or not. */
  let seenUrl: string | null = null;
  let socket: RelaySocket | null = null;
  let backoff = MIN_BACKOFF_MS;
  let reconnectTimer: unknown = null;
  let lastSentAt = 0;
  let running = false;

  function disconnect(): void {
    if (reconnectTimer !== null) env.clearTimer(reconnectTimer);
    reconnectTimer = null;
    const current = socket;
    socket = null;
    current?.close();
  }

  /** Schedules the next attempt and returns its delay, or `null` when none is due. */
  function scheduleReconnect(): number | null {
    if (!running || target === '' || reconnectTimer !== null) return null;
    const delay = backoff;
    backoff = Math.min(MAX_BACKOFF_MS, backoff * 2);
    reconnectTimer = env.setTimer(() => {
      reconnectTimer = null;
      connect();
    }, delay);
    return delay;
  }

  function retry(message: string, data: Record<string, unknown> = {}): void {
    const delay = scheduleReconnect();
    if (delay !== null) rt.log.warn(message, { url: target, retryInMs: delay, ...data });
  }

  function connect(): void {
    if (!running || target === '') return;
    let opened: RelaySocket;
    try {
      opened = env.openSocket(target);
    } catch (err) {
      retry('live: could not open the relay socket', { err: String(err) });
      return;
    }
    socket = opened;
    let wasOpen = false;
    opened.addEventListener('open', () => {
      wasOpen = true;
      backoff = MIN_BACKOFF_MS;
      rt.log.info('live: connected', { url: target });
    });
    opened.addEventListener('close', () => {
      // A socket replaced by a new URL or closed by stop() doesn't reconnect.
      if (socket !== opened) return;
      socket = null;
      if (wasOpen) {
        rt.log.info('live: relay disconnected, reconnecting', { url: target });
        scheduleReconnect();
      } else {
        retry('live: could not connect to the relay');
      }
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
      if (socket?.readyState !== OPEN) return;
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
