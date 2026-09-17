import type { AppManifest, ExperienceRuntimeContext } from '@gosai/sdk';
import type { RelaySocket } from '../src/layers/live.js';
import { createTracking } from '../src/tracking.js';
import type { PoolFrame, Tracking } from '../src/shared/types.js';

/** A canvas context that accepts every call and draws nothing. */
export const NULL_CONTEXT = new Proxy(
  {},
  { get: () => () => undefined, set: () => true },
) as CanvasRenderingContext2D;

export function frame(
  timestamp: number,
  tracking: Tracking = createTracking(),
  deltaMs = 1000 / 60,
): PoolFrame {
  return { ctx: NULL_CONTEXT, timestamp, deltaMs, frameCount: 0, tracking };
}

export interface LogEntry {
  readonly level: string;
  readonly message: string;
  readonly data?: Record<string, unknown>;
}

export function fakeRuntime(manifest: Partial<AppManifest> = {}): {
  rt: ExperienceRuntimeContext;
  logs: LogEntry[];
} {
  const logs: LogEntry[] = [];
  const log = (level: string) => (message: string, data?: Record<string, unknown>) =>
    void logs.push({ level, message, ...(data ? { data } : {}) });
  const rt = {
    app: { manifest: { slug: 'interactive-pool', ...manifest } },
    log: { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') },
  } as unknown as ExperienceRuntimeContext;
  return { rt, logs };
}

type Listener = () => void;

export class FakeSocket implements RelaySocket {
  readyState = 0;
  readonly sent: string[] = [];
  closed = false;
  private readonly listeners = new Map<string, Listener[]>();

  constructor(readonly url: string) {}

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.fire('close');
  }

  /** The server accepted the connection. */
  open(): void {
    this.readyState = 1;
    this.fire('open');
  }

  /** The connection failed or dropped. */
  fail(): void {
    this.fire('error');
    this.close();
  }

  private fire(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
}

/** Sockets and timers the test drives by hand. */
export class FakeLiveEnvironment {
  readonly sockets: FakeSocket[] = [];
  readonly timers = new Map<number, { callback: () => void; ms: number }>();
  private nextTimer = 1;

  readonly openSocket = (url: string): FakeSocket => {
    const socket = new FakeSocket(url);
    this.sockets.push(socket);
    return socket;
  };

  readonly setTimer = (callback: () => void, ms: number): number => {
    const id = this.nextTimer++;
    this.timers.set(id, { callback, ms });
    return id;
  };

  readonly clearTimer = (timer: unknown): void => {
    this.timers.delete(timer as number);
  };

  get latest(): FakeSocket | undefined {
    return this.sockets.at(-1);
  }

  /** Delays of the pending timers. */
  delays(): number[] {
    return [...this.timers.values()].map((t) => t.ms);
  }

  /** Runs every pending timer. */
  runTimers(): void {
    const due = [...this.timers.entries()];
    this.timers.clear();
    for (const [, timer] of due) timer.callback();
  }
}
