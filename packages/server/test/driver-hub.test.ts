/**
 * DriverHub with stub bridges: routing by driver name, the combined catalogue,
 * and app bridges that fail or crash on their own.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DriverInfo, DriverSchema } from '@gosai/shared';
import type { BridgeHandlers, BridgeRequestSansId, DriverBridge } from '../src/drivers/bridge.js';
import { DriverHub, type AppDriverSource } from '../src/drivers/hub.js';
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
    this.running = true;
    this.starts += 1;
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

function makeHub(options: { prepare?: (app: AppDriverSource) => Promise<void> } = {}) {
  const bus = new EventBus();
  const bridges: { builtin?: StubBridge; apps: Map<string, StubBridge> } = { apps: new Map() };
  const prepared: string[] = [];
  const hub = new DriverHub({
    logger: new Logger({ logsDir }),
    bus,
    supervisorTiming: { initialBackoffMs: 1, pingIntervalMs: 60_000 },
    bridgeReadyWaitMs: 2_000,
    createBridge: (handlers) => {
      bridges.builtin = new StubBridge(handlers, [
        { name: 'heartbeat', events: ['tick'], actions: ['echo'], dependencies: [], shared: true },
      ]);
      return bridges.builtin;
    },
    apps: {
      prepare: async (app) => {
        prepared.push(app.slug);
        await options.prepare?.(app);
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
    },
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
});
