/**
 * Driver lifecycle unit tests. A stub bridge stands in for the Python process
 * and behaves like it: it refuses to start a driver whose dependencies are not
 * running and reports state changes through the bridge handlers.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BridgeHandlers, BridgeRequestSansId, DriverBridge } from '../src/drivers/bridge.js';
import { DriverManager, SYSTEM_BINDING, type DriverManifestEntry } from '../src/drivers/manager.js';
import { EventBus } from '../src/ipc/bus.js';
import { Logger } from '../src/logger/logger.js';

interface RecordedRequest {
  readonly type: string;
  readonly instance?: string;
  readonly driver?: string;
  readonly event?: string;
  readonly action?: string;
  readonly data?: unknown;
}

const MANIFEST: DriverManifestEntry[] = [
  { name: 'camera', events: ['color', 'frame'], actions: ['set_mode'], dependencies: [] },
  { name: 'calibration', events: ['homography'], actions: [], dependencies: ['camera'] },
  { name: 'unrelated', events: ['tick'], actions: [], dependencies: [] },
  { name: 'speaker', events: ['level'], actions: ['play'], dependencies: [], shared: true },
];

class StubBridge implements DriverBridge {
  running = false;
  starts = 0;
  hung = false;
  requests: RecordedRequest[] = [];
  readonly instances = new Map<string, string>();
  readonly subscriptions = new Set<string>();
  readonly failStart = new Map<string, string>();

  constructor(readonly handlers: BridgeHandlers) {}

  isRunning(): boolean {
    return this.running;
  }

  async start(): Promise<void> {
    this.running = true;
    this.hung = false;
    this.starts += 1;
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.exit(0);
  }

  crash(): void {
    this.exit(1);
  }

  async ping(): Promise<number> {
    if (this.hung) throw new Error('ping timed out');
    return 0;
  }

  async request<T = unknown>(req: BridgeRequestSansId): Promise<T> {
    if (!this.running) throw new Error('Python bridge is not running');
    this.requests.push({ ...req });
    return this.respond(req) as T;
  }

  private respond(req: BridgeRequestSansId): unknown {
    switch (req.type) {
      case 'list-drivers':
        return { drivers: MANIFEST };
      case 'list-instances':
        return { instances: [] };
      case 'start-driver': {
        const key = `${req.instance}::${req.driver}`;
        const entry = MANIFEST.find((d) => d.name === req.driver);
        for (const dep of entry?.dependencies ?? []) {
          if (this.instances.get(`${req.instance}::${dep}`) !== 'running') {
            throw new Error(`driver '${req.driver}' needs ${dep} running first`);
          }
        }
        if (this.instances.get(key) === 'running') return { state: 'running' };
        this.handlers.onDriverState(req.instance, req.driver, 'starting');
        const failure = this.failStart.get(req.driver);
        if (failure) throw new Error(failure);
        this.instances.set(key, 'running');
        this.handlers.onDriverState(req.instance, req.driver, 'running');
        return { state: 'running' };
      }
      case 'stop-driver': {
        const key = `${req.instance}::${req.driver}`;
        if (!this.instances.has(key)) return { state: 'available' };
        this.handlers.onDriverState(req.instance, req.driver, 'stopping');
        this.instances.delete(key);
        for (const sub of this.subscriptions) {
          if (sub.startsWith(`${key}::`)) this.subscriptions.delete(sub);
        }
        this.handlers.onDriverState(req.instance, req.driver, 'available');
        return { state: 'available' };
      }
      case 'subscribe':
        this.subscriptions.add(`${req.instance}::${req.driver}::${req.event}`);
        return undefined;
      case 'unsubscribe':
        this.subscriptions.delete(`${req.instance}::${req.driver}::${req.event}`);
        return undefined;
      default:
        return undefined;
    }
  }

  private exit(code: number): void {
    this.running = false;
    this.instances.clear();
    this.subscriptions.clear();
    this.handlers.onExit(code, null);
  }
}

const logsDir = mkdtempSync(join(tmpdir(), 'gosai-test-'));
const managers: DriverManager[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.stop()));
});

interface Harness {
  readonly manager: DriverManager;
  readonly bridge: StubBridge;
  readonly bus: EventBus;
}

async function startManager(
  options: {
    getDriverConfig?: (binding: string, driver: string) => Record<string, unknown> | undefined;
    pingIntervalMs?: number;
  } = {},
): Promise<Harness> {
  const bus = new EventBus();
  let bridge: StubBridge | undefined;
  const manager = new DriverManager({
    pythonDir: '/dev/null',
    logger: new Logger({ logsDir }),
    bus,
    ...(options.getDriverConfig ? { getDriverConfig: options.getDriverConfig } : {}),
    createBridge: (handlers) => {
      bridge = new StubBridge(handlers);
      return bridge;
    },
    supervisorTiming: {
      initialBackoffMs: 1,
      pingIntervalMs: options.pingIntervalMs ?? 60_000,
      pingTimeoutMs: 5,
      maxMissedPings: 2,
    },
  });
  managers.push(manager);
  await manager.start();
  if (!bridge) throw new Error('bridge factory was not called');
  bridge.requests = [];
  return { manager, bridge, bus };
}

const lifecycle = (bridge: StubBridge, type: 'start-driver' | 'stop-driver'): string[] =>
  bridge.requests.filter((r) => r.type === type).map((r) => `${r.instance}/${r.driver}`);

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('driver leases', () => {
  test('starting a driver starts its dependencies first', async () => {
    const { manager, bridge } = await startManager();

    await manager.subscribe(SYSTEM_BINDING, 'calibration', '*', 'expA');

    expect(lifecycle(bridge, 'start-driver')).toEqual(['system/camera', 'system/calibration']);
    expect(manager.getDriver('camera')?.instances?.[0]?.subscribers).toEqual(['calibration:dep']);
  });

  test('releasing the last lease stops dependents before dependencies', async () => {
    const { manager, bridge } = await startManager();
    await manager.subscribe(SYSTEM_BINDING, 'calibration', '*', 'expA');
    bridge.requests = [];

    await manager.unsubscribe(SYSTEM_BINDING, 'calibration', '*', 'expA');

    expect(lifecycle(bridge, 'stop-driver')).toEqual(['system/calibration', 'system/camera']);
    expect(bridge.instances.size).toBe(0);
    expect(manager.getDriver('camera')?.state).toBe('available');
  });

  test('a named event lease starts and stops the driver', async () => {
    const { manager, bridge } = await startManager();

    await manager.subscribe('appA', 'camera', 'color', 'client');
    expect(bridge.subscriptions).toEqual(new Set(['appA::camera::color']));
    expect(manager.isInstanceRunning('appA', 'camera')).toBe(true);

    await manager.unsubscribe('appA', 'camera', 'color', 'client');
    expect(lifecycle(bridge, 'stop-driver')).toEqual(['appA/camera']);
    expect(manager.isInstanceRunning('appA', 'camera')).toBe(false);
  });

  test('a client that subscribes twice holds two leases', async () => {
    const { manager, bridge } = await startManager();
    await manager.subscribe('appA', 'camera', 'color', 'client');
    await manager.subscribe('appA', 'camera', 'color', 'client');

    await manager.unsubscribe('appA', 'camera', 'color', 'client');
    expect(lifecycle(bridge, 'stop-driver')).toEqual([]);
    expect(bridge.subscriptions.size).toBe(1);

    await manager.unsubscribe('appA', 'camera', 'color', 'client');
    expect(lifecycle(bridge, 'stop-driver')).toEqual(['appA/camera']);
  });

  test('unsubscribing one event keeps the other event subscribed', async () => {
    const { manager, bridge } = await startManager();
    await manager.subscribe('appA', 'camera', 'color', 'a');
    await manager.subscribe('appA', 'camera', 'frame', 'b');

    await manager.unsubscribe('appA', 'camera', 'color', 'a');

    expect(bridge.subscriptions).toEqual(new Set(['appA::camera::frame']));
    expect(manager.isInstanceRunning('appA', 'camera')).toBe(true);
  });

  test('a dependency that is already running is reused and reported running', async () => {
    const { manager, bridge } = await startManager();
    await manager.subscribe('appA', 'camera', 'color', 'viewer');

    await manager.subscribe('appA', 'calibration', '*', 'wizard');

    expect(lifecycle(bridge, 'start-driver')).toEqual(['appA/camera', 'appA/calibration']);
    expect(manager.isInstanceRunning('appA', 'camera')).toBe(true);
    expect(manager.runningBindings('camera')).toEqual(['appA']);

    bridge.requests = [];
    await manager.unsubscribe('appA', 'calibration', '*', 'wizard');
    expect(lifecycle(bridge, 'stop-driver')).toEqual(['appA/calibration']);
    expect(manager.isInstanceRunning('appA', 'camera')).toBe(true);
  });

  test('independent drivers do not affect each other', async () => {
    const { manager, bridge } = await startManager();
    await manager.subscribe('appA', 'calibration', '*', 'expA');
    await manager.subscribe('appA', 'unrelated', '*', 'expB');
    bridge.requests = [];

    await manager.unsubscribe('appA', 'calibration', '*', 'expA');
    expect(lifecycle(bridge, 'stop-driver')).toEqual(['appA/calibration', 'appA/camera']);
    expect(manager.isInstanceRunning('appA', 'unrelated')).toBe(true);
  });

  test('disconnecting a client releases all of its leases', async () => {
    const { manager, bridge } = await startManager();
    await manager.subscribe('appA', 'camera', 'color', 'socket');
    await manager.subscribe('appA', 'unrelated', 'tick', 'socket');

    await manager.unsubscribeAll('socket');

    expect(bridge.instances.size).toBe(0);
  });

  test('exclusive drivers get one instance per binding', async () => {
    const { manager, bridge } = await startManager();

    await manager.subscribe('appA', 'camera', '*', 'a');
    await manager.subscribe('appB', 'camera', '*', 'b');
    expect(lifecycle(bridge, 'start-driver')).toEqual(['appA/camera', 'appB/camera']);

    await manager.unsubscribe('appA', 'camera', '*', 'a');
    expect(lifecycle(bridge, 'stop-driver')).toEqual(['appA/camera']);
    expect(manager.isInstanceRunning('appA', 'camera')).toBe(false);
    expect(manager.isInstanceRunning('appB', 'camera')).toBe(true);
  });

  test('shared drivers collapse to a single instance across bindings', async () => {
    const { manager, bridge } = await startManager();

    await manager.subscribe('appA', 'speaker', '*', 'a');
    await manager.subscribe('appB', 'speaker', '*', 'b');
    expect(lifecycle(bridge, 'start-driver')).toEqual(['shared/speaker']);
    const info = manager.getDriver('speaker');
    expect(info?.shared).toBe(true);
    expect(info?.instances).toHaveLength(1);

    await manager.unsubscribe('appA', 'speaker', '*', 'a');
    expect(lifecycle(bridge, 'stop-driver')).toEqual([]);
    expect(manager.getDriver('speaker')?.state).toBe('running');

    await manager.unsubscribe('appB', 'speaker', '*', 'b');
    expect(lifecycle(bridge, 'stop-driver')).toEqual(['shared/speaker']);
  });

  test('a device change during a subscription still releases the original instance', async () => {
    let device = 1;
    const { manager, bridge } = await startManager({
      getDriverConfig: (_binding, driver) => (driver === 'speaker' ? { device } : undefined),
    });
    await manager.subscribe('appA', 'speaker', 'level', 'a');
    expect(lifecycle(bridge, 'start-driver')).toEqual(['shared:dev1/speaker']);

    device = 2;
    await manager.execute('appA', 'speaker', 'play', [0]);
    expect(bridge.requests.find((r) => r.type === 'execute')?.instance).toBe('shared:dev1');

    await manager.unsubscribe('appA', 'speaker', 'level', 'a');
    expect(lifecycle(bridge, 'stop-driver')).toEqual(['shared:dev1/speaker']);
    expect(bridge.instances.size).toBe(0);
  });

  test('the startup config comes from the binding that holds the lease', async () => {
    const configs: Array<[string, string]> = [];
    const { manager } = await startManager({
      getDriverConfig: (binding, driver) => {
        configs.push([binding, driver]);
        return undefined;
      },
    });
    await manager.subscribe('appA', 'calibration', '*', 'a');
    expect(configs).toEqual([
      ['appA', 'camera'],
      ['appA', 'calibration'],
    ]);
  });
});

describe('driver failures', () => {
  test('a failed start rejects the subscription and releases its dependencies', async () => {
    const { manager, bridge } = await startManager();
    bridge.failStart.set('calibration', 'marker dictionary missing');

    await expect(manager.subscribe('appA', 'calibration', '*', 'a')).rejects.toThrow(
      'driver calibration failed to start: marker dictionary missing',
    );
    expect(lifecycle(bridge, 'stop-driver')).toEqual(['appA/camera']);
    expect(manager.getDriver('calibration')?.state).toBe('available');

    bridge.failStart.clear();
    await manager.subscribe('appA', 'calibration', '*', 'a');
    expect(manager.isInstanceRunning('appA', 'calibration')).toBe(true);
  });

  test('stopping is reported as stopping, not errored', async () => {
    const { manager, bridge } = await startManager();
    await manager.subscribe('appA', 'camera', '*', 'a');

    bridge.handlers.onDriverState('appA', 'camera', 'stopping');

    expect(manager.getDriver('camera')?.state).toBe('stopping');
  });

  test('subscribing while the bridge is down fails', async () => {
    const { manager, bridge } = await startManager({ pingIntervalMs: 60_000 });
    await manager.stop();
    expect(bridge.isRunning()).toBe(false);
    await expect(manager.subscribe('appA', 'camera', '*', 'a')).rejects.toThrow(
      'Python bridge is not running',
    );
  });
});

describe('bridge restarts', () => {
  test('leases are re-applied after the bridge crashes', async () => {
    const { manager, bridge, bus } = await startManager();
    await manager.subscribe('appA', 'calibration', 'homography', 'wizard');

    bridge.requests = [];
    bridge.crash();
    expect(manager.getDriver('calibration')?.state).toBe('available');

    await waitFor(() => bridge.subscriptions.size === 1);
    expect(bridge.starts).toBe(2);
    expect(lifecycle(bridge, 'start-driver')).toEqual(['appA/camera', 'appA/calibration']);
    expect(bridge.subscriptions).toEqual(new Set(['appA::calibration::homography']));
    expect(manager.isInstanceRunning('appA', 'calibration')).toBe(true);

    const received: unknown[] = [];
    bus.on('driver:event:appA', (_event, payload) => received.push(payload));
    bridge.handlers.onEvent('appA', 'calibration', 'homography', { matrix: [] }, 1);
    expect(received).toHaveLength(1);
  });

  test('a bridge that stops answering pings is restarted', async () => {
    const { manager, bridge } = await startManager({ pingIntervalMs: 5 });
    await manager.subscribe('appA', 'camera', 'color', 'viewer');

    bridge.hung = true;

    await waitFor(() => bridge.starts === 2 && bridge.subscriptions.size === 1);
    expect(manager.isInstanceRunning('appA', 'camera')).toBe(true);
  });
});

describe('event routing', () => {
  test('events fan out to every binding holding a lease on the event', async () => {
    const { manager, bridge, bus } = await startManager();
    await manager.subscribe('appA', 'speaker', '*', 'a');
    await manager.subscribe('appB', 'speaker', 'level', 'b');
    await manager.subscribe('appC', 'speaker', 'other', 'c');

    const seen: Record<string, Array<Record<string, unknown>>> = { appA: [], appB: [], appC: [] };
    for (const binding of Object.keys(seen)) {
      bus.on(`driver:event:${binding}`, (_e, payload) =>
        seen[binding]?.push(payload as Record<string, unknown>),
      );
    }

    bridge.handlers.onEvent('shared', 'speaker', 'level', { rms: 0.5 }, 123);

    expect(seen.appA).toHaveLength(1);
    expect(seen.appB).toHaveLength(1);
    expect(seen.appC).toHaveLength(0);
    expect(seen.appA?.[0]).toEqual({
      driver: 'speaker',
      event: 'level',
      data: { rms: 0.5 },
      ts: 123,
      binding: 'appA',
    });
  });

  test('an exclusive instance never leaks events to another binding', async () => {
    const { manager, bridge, bus } = await startManager();
    await manager.subscribe('appA', 'camera', '*', 'a');

    const a: unknown[] = [];
    const b: unknown[] = [];
    bus.on('driver:event:appA', (_e, p) => a.push(p));
    bus.on('driver:event:appB', (_e, p) => b.push(p));

    bridge.handlers.onEvent('appA', 'camera', 'color', {}, 1);

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(0);
  });

  test('driver runtime metadata is exposed on driver info', async () => {
    const { manager, bridge } = await startManager();
    await manager.subscribe('appA', 'camera', '*', 'a');

    bridge.handlers.onDriverState('appA', 'camera', 'running', {
      backend: 'onnxruntime',
      provider: 'CUDAExecutionProvider',
      device: 'cuda',
      accelerated: true,
    });

    const info = manager.getDriver('camera');
    expect(info?.runtime?.device).toBe('cuda');
    expect(info?.runtime?.provider).toBe('CUDAExecutionProvider');
    expect(info?.instances?.[0]?.runtime?.accelerated).toBe(true);
  });

  test('driver metrics and logs keep their instance', async () => {
    const { bridge, bus } = await startManager();
    const samples: unknown[] = [];
    bus.on('server:performance', (_e, payload) => samples.push(payload));

    bridge.handlers.onPerformance({
      instance: 'appA',
      source: 'camera',
      metric: 'loop_ms',
      value: 2,
      ts: 1_700_000_000_000,
    });

    expect(samples).toEqual([
      {
        source: 'camera',
        instance: 'appA',
        type: 'driver',
        metric: 'loop_ms',
        value: 2,
        timestamp: 1_700_000_000_000,
      },
    ]);
  });
});
