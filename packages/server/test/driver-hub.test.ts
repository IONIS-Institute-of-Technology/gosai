/**
 * DriverHub with stub bridges: routing by driver name, the combined catalogue,
 * and app bridges that fail or crash on their own.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DriverInfo, DriverSchema } from '@gosai/shared';
import { appBridgeEnv } from '../src/drivers/app-drivers.js';
import type { BridgeHandlers, BridgeRequestSansId, DriverBridge } from '../src/drivers/bridge.js';
import { DriverHub, type AppBridgeProvider, type AppDriverSource } from '../src/drivers/hub.js';
import type { DriverManifestEntry } from '../src/drivers/manager.js';
import { EventBus } from '../src/ipc/bus.js';
import { Logger } from '../src/logger/logger.js';

const SCHEMA: DriverSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  config: null,
  events: { count: { description: 'The count.', delivery: 'ordered', payload: {} } },
  actions: {},
  $defs: {},
};

class StubBridge implements DriverBridge {
  running = false;
  starts = 0;
  /** Start attempts left to fail. */
  failStarts = 0;
  readonly requests: BridgeRequestSansId[] = [];
  private readonly instances = new Set<string>();

  constructor(
    readonly handlers: BridgeHandlers,
    private readonly catalogue: readonly DriverManifestEntry[],
  ) {}

  isRunning(): boolean {
    return this.running;
  }

  async start(): Promise<void> {
    this.starts += 1;
    if (this.failStarts > 0) {
      this.failStarts -= 1;
      throw new Error('gosai-bridge exited: No module named cv2');
    }
    this.running = true;
  }

  async stop(): Promise<void> {
    if (this.running) this.exit(0);
  }

  crash(): void {
    this.exit(1);
  }

  async ping(): Promise<number> {
    return 0;
  }

  async request<T = unknown>(req: BridgeRequestSansId): Promise<T> {
    if (!this.running) throw new Error('Python bridge is not running');
    this.requests.push(req);
    switch (req.type) {
      case 'list-drivers':
        return { drivers: this.catalogue } as T;
      case 'list-instances':
        return { instances: [] } as T;
      case 'start-driver':
        this.instances.add(`${req.instance}::${req.driver}`);
        this.handlers.onDriverState(req.instance, req.driver, 'running');
        return { driver: req.driver, state: 'running' } as T;
      case 'stop-driver':
        this.instances.delete(`${req.instance}::${req.driver}`);
        this.handlers.onDriverState(req.instance, req.driver, 'available');
        return { driver: req.driver, state: 'available' } as T;
      case 'execute':
        return { driver: req.driver, action: req.action } as T;
      default:
        return undefined as T;
    }
  }

  emit(instance: string, driver: string, event: string, data: unknown): void {
    this.handlers.onEvent(instance, driver, event, data, Date.now());
  }

  private exit(code: number): void {
    this.running = false;
    this.instances.clear();
    this.handlers.onExit(code, null);
  }
}

const logsDir = mkdtempSync(join(tmpdir(), 'gosai-hub-test-'));
const hubs: DriverHub[] = [];

afterEach(async () => {
  await Promise.all(hubs.splice(0).map((hub) => hub.stop()));
});

const APP: AppDriverSource = {
  slug: 'hello-app',
  installPath: '/apps/hello-app',
  builtin: false,
  python: { drivers: 'python/hello_drivers' },
};

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function makeHub(
  options: {
    prepare?: (app: AppDriverSource, signal: AbortSignal) => Promise<void>;
    prepareWaitMs?: number;
    unavailable?: string;
    withoutApps?: boolean;
    builtinStartFailures?: number;
    initialBackoffMs?: number;
  } = {},
) {
  const bus = new EventBus();
  const bridges: { builtin?: StubBridge; apps: Map<string, StubBridge> } = { apps: new Map() };
  const prepared: string[] = [];
  const apps: AppBridgeProvider = {
    prepare: async (app, signal) => {
      prepared.push(app.slug);
      await options.prepare?.(app, signal);
    },
    createBridge: (app, handlers) => {
      const bridge = new StubBridge(handlers, [
        {
          name: 'counter',
          events: ['count'],
          actions: ['reset'],
          dependencies: [],
          schema: SCHEMA,
        },
        { name: 'doubler', events: ['value'], actions: [], dependencies: ['counter'] },
      ]);
      bridges.apps.set(app.slug, bridge);
      return bridge;
    },
  };
  const hub = new DriverHub({
    logger: new Logger({ logsDir }),
    bus,
    supervisorTiming: { initialBackoffMs: options.initialBackoffMs ?? 1, pingIntervalMs: 60_000 },
    bridgeReadyWaitMs: 2_000,
    ...(options.prepareWaitMs !== undefined ? { prepareWaitMs: options.prepareWaitMs } : {}),
    ...(options.unavailable !== undefined ? { unavailable: options.unavailable } : {}),
    createBridge: (handlers) => {
      bridges.builtin = new StubBridge(handlers, [
        { name: 'heartbeat', events: ['tick'], actions: ['echo'], dependencies: [], shared: true },
      ]);
      bridges.builtin.failStarts = options.builtinStartFailures ?? 0;
      return bridges.builtin;
    },
    ...(options.withoutApps ? {} : { apps }),
  });
  hubs.push(hub);
  return { hub, bus, bridges, prepared };
}

describe('driver hub', () => {
  test('routes app drivers to their own bridge under their plain names', async () => {
    const { hub, bus, bridges, prepared } = makeHub();
    await hub.start();
    hub.sync([APP]);
    const events: unknown[] = [];
    bus.on('driver:event:hello-app', (_event, payload) => events.push(payload));

    await hub.subscribe('hello-app', 'hello-app/doubler', '*', 'client');
    await hub.subscribe('hello-app', 'heartbeat', 'tick', 'client');

    const app = bridges.apps.get('hello-app')!;
    expect(prepared).toEqual(['hello-app']);
    expect(
      app.requests
        .filter((r) => r.type === 'start-driver')
        .map((r) => ('driver' in r ? r.driver : '')),
    ).toEqual(['counter', 'doubler']);
    expect(bridges.builtin!.requests.some((r) => 'driver' in r && r.driver !== 'heartbeat')).toBe(
      false,
    );

    app.emit('hello-app', 'doubler', 'value', 2);
    expect(events).toEqual([
      expect.objectContaining({ driver: 'hello-app/doubler', event: 'value', data: 2 }),
    ]);
    expect(await hub.execute('hello-app', 'hello-app/counter', 'reset', 0)).toEqual({
      driver: 'counter',
      action: 'reset',
    });

    expect(hub.listDrivers().map((d) => d.name)).toEqual([
      'heartbeat',
      'hello-app/counter',
      'hello-app/doubler',
    ]);
    expect(hub.getDriver('hello-app/doubler')).toMatchObject({
      state: 'running',
      dependencies: ['hello-app/counter'],
    });
    expect(Object.keys(hub.getSchemas().schemas)).toEqual([
      'heartbeat',
      'hello-app/counter',
      'hello-app/doubler',
    ]);
    expect(hub.getSchemas('hello-app/counter').schemas['hello-app/counter']?.schema).toEqual(
      SCHEMA,
    );
    expect(hub.isInstanceRunning('hello-app', 'hello-app/counter')).toBe(true);
    expect(() => hub.getSchemas('other-app/counter')).toThrow('Unknown driver: other-app/counter');
    await expect(hub.subscribe('hello-app', 'other-app/counter', '*', 'c')).rejects.toThrow(
      'Unknown driver',
    );
  });

  test('a crashed app bridge restarts on its own while built-in drivers keep running', async () => {
    const { hub, bridges } = makeHub();
    await hub.start();
    hub.sync([APP]);
    await hub.subscribe('hello-app', 'heartbeat', 'tick', 'client');
    await hub.subscribe('hello-app', 'hello-app/counter', 'count', 'client');
    const app = bridges.apps.get('hello-app')!;
    const builtin = bridges.builtin!;

    app.crash();
    await waitFor(
      () => app.starts === 2 && hub.getDriver('hello-app/counter')?.state === 'running',
    );

    expect(builtin.starts).toBe(1);
    expect(builtin.running).toBe(true);
    expect(hub.getDriver('heartbeat')?.state).toBe('running');
  });

  test('a failed environment fails the subscription and is prepared again next time', async () => {
    let fail = true;
    const { hub, prepared } = makeHub({
      prepare: async () => {
        if (fail) throw new Error('uv pip install failed');
      },
    });
    await hub.start();
    hub.sync([APP]);

    await expect(hub.subscribe('hello-app', 'hello-app/counter', 'count', 'c')).rejects.toThrow(
      'the drivers of hello-app are unavailable: uv pip install failed',
    );
    fail = false;
    await hub.subscribe('hello-app', 'hello-app/counter', 'count', 'c');
    expect(prepared).toEqual(['hello-app', 'hello-app']);
    expect(hub.getDriver('heartbeat')).toBeDefined();
  });

  test('without Python, every driver call fails with the reason', async () => {
    const reason = 'there is no Python environment at /py/.venv; run `uv sync` in /py';
    const { hub, bridges } = makeHub({ unavailable: reason, withoutApps: true });
    await hub.start();
    hub.sync([APP]);
    const message = `Python drivers are unavailable: ${reason}`;

    expect(hub.unavailableReason()).toBe(reason);
    await expect(hub.subscribe('pool', 'pose', '*', 'c')).rejects.toThrow(message);
    expect(() => hub.execute('pool', 'pose', 'reset', {})).toThrow(message);
    expect(() => hub.getData('pool', 'pose', 'landmarks')).toThrow(message);
    expect(() => hub.getSchemas('pose')).toThrow(message);
    // App environments build on the same Python, so app drivers can't run either.
    await expect(hub.subscribe('hello-app', 'hello-app/counter', '*', 'c')).rejects.toThrow(
      message,
    );
    expect(bridges.builtin?.starts).toBe(0);
    expect(hub.listDrivers()).toEqual([]);
  });

  test('built-in drivers report why their bridge never started, and work once it does', async () => {
    const { hub, bridges } = makeHub({ builtinStartFailures: 1, initialBackoffMs: 200 });
    hub.sync([APP]);
    await expect(hub.start()).rejects.toThrow('No module named cv2');

    const message = 'Python drivers are unavailable: gosai-bridge exited: No module named cv2';
    expect(hub.unavailableReason()).toBe('gosai-bridge exited: No module named cv2');
    await expect(hub.subscribe('pool', 'heartbeat', 'tick', 'c')).rejects.toThrow(message);
    expect(() => hub.execute('pool', 'heartbeat', 'echo', {})).toThrow(message);
    // App drivers have a bridge of their own.
    await hub.subscribe('hello-app', 'hello-app/counter', 'count', 'c');

    await waitFor(() => hub.unavailableReason() === null);
    await hub.subscribe('pool', 'heartbeat', 'tick', 'c');
    expect(bridges.builtin?.starts).toBe(2);
  });

  test('keeps app bridges in step with the apps and lists every driver in one event', async () => {
    const { hub, bus, bridges } = makeHub();
    const lists: string[][] = [];
    bus.on('drivers:list-changed', (_event, payload) =>
      lists.push((payload as { drivers: DriverInfo[] }).drivers.map((d) => d.name)),
    );
    hub.sync([APP]);
    await hub.start();
    await hub.subscribe('hello-app', 'hello-app/counter', 'count', 'c');
    expect(lists.at(-1)).toEqual(['heartbeat', 'hello-app/counter', 'hello-app/doubler']);

    // The same app again changes nothing; a moved app gets a new bridge.
    const first = bridges.apps.get('hello-app')!;
    hub.sync([APP]);
    expect(bridges.apps.get('hello-app')).toBe(first);
    hub.sync([{ ...APP, installPath: '/elsewhere/hello-app' }]);
    await hub.subscribe('hello-app', 'hello-app/counter', 'count', 'c');
    expect(bridges.apps.get('hello-app')).not.toBe(first);
    await waitFor(() => !first.running);

    await hub.release('hello-app');
    expect(hub.listDrivers().map((d) => d.name)).toEqual(['heartbeat']);
    expect(lists.at(-1)).toEqual(['heartbeat']);
    expect(hub.getDriver('hello-app/counter')).toBeUndefined();
  });

  /** A prepare that runs until aborted, like a uv build, and records when it ended. */
  function hangingPrepare(): {
    prepare: (app: AppDriverSource, signal: AbortSignal) => Promise<void>;
    ended: string[];
  } {
    const ended: string[] = [];
    return {
      ended,
      prepare: (_app, signal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            // uv takes a moment to die.
            setTimeout(() => {
              ended.push('prepare');
              reject(new Error('uv pip install was cancelled'));
            }, 20);
          });
        }),
    };
  }

  test('stopping the hub cancels an environment build and waits for it to end', async () => {
    const { prepare, ended } = hangingPrepare();
    const { hub, bridges } = makeHub({ prepare });
    hub.sync([APP]);
    await hub.start();

    await hub.stop();
    ended.push('stop');

    expect(ended).toEqual(['prepare', 'stop']);
    expect(bridges.apps.get('hello-app')?.starts).toBe(0);
  });

  test('releasing an app cancels its environment build before returning', async () => {
    const { prepare, ended } = hangingPrepare();
    const { hub } = makeHub({ prepare });
    await hub.start();
    hub.sync([APP]);

    await hub.release('hello-app');
    ended.push('released');

    expect(ended).toEqual(['prepare', 'released']);
  });

  test('a subscription fails fast while the environment is still being built', async () => {
    let finish: () => void = () => undefined;
    const { hub, prepared } = makeHub({
      prepareWaitMs: 50,
      prepare: () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    });
    await hub.start();
    hub.sync([APP]);

    const started = Date.now();
    await expect(hub.subscribe('hello-app', 'hello-app/counter', 'count', 'c')).rejects.toThrow(
      'Python environment for hello-app is still being prepared',
    );
    expect(Date.now() - started).toBeLessThan(1_000);

    // The build went on; once it is done the same subscription works, without a second build.
    finish();
    await hub.subscribe('hello-app', 'hello-app/counter', 'count', 'c');
    expect(prepared).toEqual(['hello-app']);
    expect(hub.getDriver('hello-app/counter')?.state).toBe('running');
  });

  test('app bridges write bytecode into the environment, not the app', () => {
    const app: AppDriverSource = {
      slug: 'hello-app',
      installPath: '/apps/hello-app',
      builtin: true,
      python: { drivers: 'python/hello_drivers' },
    };
    expect(appBridgeEnv(app, '/envs/builtin/hello-app', { data: '/data' })).toEqual({
      GOSAI_APP_SLUG: 'hello-app',
      GOSAI_APP_DIR: '/apps/hello-app',
      GOSAI_APP_DATA_DIR: join('/data', 'hello-app'),
      PYTHONPYCACHEPREFIX: join('/envs/builtin/hello-app', 'pycache'),
    });
  });
});
