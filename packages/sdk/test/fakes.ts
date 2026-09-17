import type { AppManifest } from '@gosai/shared';
import type { ConnectionStatus } from '@gosai/shared/client';
import type { WelcomePayload } from '@gosai/shared/protocol';
import type { FrameScheduler, RuntimeOptions } from '../src/runtime.js';
import type { ServerConnection } from '../src/types.js';

export interface SentRequest {
  readonly type: string;
  readonly payload: unknown;
}

type Resource = { acquire(): Promise<void>; release(): Promise<void> };

/**
 * In-memory server connection that records requests and listeners. Its
 * methods are untyped; `connection` hands it to code that wants the typed
 * `ServerConnection`.
 */
export class FakeServer {
  readonly requests: SentRequest[] = [];
  readonly authToken = undefined;
  serverInfo: WelcomePayload | null = null;
  private readonly statusListeners = new Set<(status: ConnectionStatus) => void>();
  private readonly holds = new Map<string, { count: number; resource: Resource }>();
  private readonly errorListeners = new Set<(error: unknown, context: string) => void>();
  readonly listeners = new Map<string, Set<(payload: unknown) => void>>();
  closed = false;
  /** Returns the reply for a request, or throws to reject it. */
  reply: (type: string, payload: unknown) => unknown = () => ({ ok: true });

  connected(): boolean {
    return !this.closed;
  }

  async request<T = unknown>(type: string, payload: unknown = {}): Promise<T> {
    this.requests.push({ type, payload });
    return this.reply(type, payload) as T;
  }

  on(event: string, listener: (payload: unknown) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return () => set.delete(listener);
  }

  onStatus(listener: (status: ConnectionStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  /** Simulates a reconnect that the server welcomed with `welcome`. */
  reconnect(welcome: WelcomePayload): void {
    this.serverInfo = welcome;
    for (const listener of this.statusListeners) listener('connected');
  }

  onError(listener: (error: unknown, context: string) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  /** Shares one acquisition per key, like ServerClient, without reconnects. */
  retain(key: string, resource: Resource): { ready: Promise<void>; release(): void } {
    const existing = this.holds.get(key);
    if (existing) existing.count += 1;
    else this.holds.set(key, { count: 1, resource });
    const ready = existing ? Promise.resolve() : resource.acquire();
    ready.catch((err: unknown) => this.reportError(err, `acquiring ${key}`));
    let released = false;
    return {
      ready,
      release: () => {
        const hold = this.holds.get(key);
        if (released || !hold) return;
        released = true;
        hold.count -= 1;
        if (hold.count > 0) return;
        this.holds.delete(key);
        void hold.resource.release().catch(() => undefined);
      },
    };
  }

  reportError(error: unknown, context: string): void {
    for (const listener of this.errorListeners) listener(error, context);
  }

  get connection(): ServerConnection & { close(): void } {
    return this as unknown as ServerConnection & { close(): void };
  }

  close(): void {
    this.closed = true;
  }

  emit(event: string, payload: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }

  listenerCount(): number {
    let count = 0;
    for (const set of this.listeners.values()) count += set.size;
    return count;
  }

  requestsOf(type: string): SentRequest[] {
    return this.requests.filter((r) => r.type === type);
  }
}

/** Frame scheduler driven by hand with `tick`. */
export class FakeFrames implements FrameScheduler {
  private pending = new Map<number, (timestamp: number) => void>();
  private nextHandle = 1;
  time = 1000;

  request(callback: (timestamp: number) => void): number {
    const handle = this.nextHandle++;
    this.pending.set(handle, callback);
    return handle;
  }

  cancel(handle: number): void {
    this.pending.delete(handle);
  }

  now(): number {
    return this.time;
  }

  /** Advances the clock and runs the callbacks that were waiting. */
  tick(elapsedMs = 16): void {
    this.time += elapsedMs;
    const due = [...this.pending.values()];
    this.pending.clear();
    for (const callback of due) callback(this.time);
  }

  get scheduled(): number {
    return this.pending.size;
  }
}

export const MANIFEST: AppManifest = {
  slug: 'demo',
  name: 'Demo',
  version: '1.0.0',
  experiences: [
    {
      slug: 'main',
      name: 'Main',
      description: 'The main experience',
      entry: 'dist/main.js',
      drivers: ['heartbeat'],
      exclusive: false,
    },
  ],
  settings: {
    storageKey: 'config',
    groups: [
      {
        label: 'Display',
        fields: [
          { key: 'display.mode', label: 'Mode', type: 'string', default: 'contain' },
          { key: 'display.zoom', label: 'Zoom', type: 'number', default: 1 },
          { key: 'debug', label: 'Debug', type: 'boolean', default: false },
        ],
      },
    ],
  },
};

export function runtimeOptions(overrides: Partial<RuntimeOptions> = {}): RuntimeOptions {
  return {
    appSlug: 'demo',
    experienceSlug: 'main',
    manifest: MANIFEST,
    serverBaseUrl: 'http://demo.localhost:7777',
    ...overrides,
  };
}
