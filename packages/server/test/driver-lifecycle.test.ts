/**
 * Driver lifecycle unit tests. Use a stubbed PythonBridge so the tests are
 * fast and don't require a real bridge.
 *
 * Verifies:
 * - Starting a driver also starts its dependencies.
 * - Stopping a driver releases its dependencies once nothing else needs them.
 * - A second active subscriber keeps a dependency running.
 * - Exclusive drivers get one instance per binding (two apps -> two cameras).
 * - Shared drivers collapse to a single instance and fan events out to every
 *   subscribing binding's `driver:event:<binding>` topic.
 */

import { describe, expect, test } from 'bun:test';
import { Logger } from '../src/logger/logger.js';
import { EventBus } from '../src/ipc/bus.js';
import { DriverManager, SYSTEM_BINDING, type DriverManifestEntry } from '../src/drivers/manager.js';
import type { PythonBridge } from '../src/drivers/bridge.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface RecordedRequest {
  type: string;
  driver?: string;
  instance?: string;
  event?: string;
}

class StubBridge {
  running = false;
  events: RecordedRequest[] = [];
  manifest: readonly DriverManifestEntry[];
  onState?: (instance: string, driver: string, state: string) => void;

  constructor(manifest: DriverManifestEntry[]) {
    this.manifest = manifest;
  }

  isRunning(): boolean {
    return this.running;
  }

  async start(): Promise<void> {
    this.running = true;
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  async request<T = unknown>(req: {
    type: string;
    driver?: string;
    instance?: string;
    event?: string;
    action?: string;
    data?: unknown;
  }): Promise<T> {
    this.events.push({
      type: req.type,
      driver: req.driver,
      instance: req.instance,
      event: req.event,
    });
    if (req.type === 'list-drivers') {
      return { drivers: this.manifest } as T;
    }
    if (req.type === 'start-driver' && req.instance && req.driver) {
      this.onState?.(req.instance, req.driver, 'running');
    }
    return undefined as T;
  }
}

const logsDir = mkdtempSync(join(tmpdir(), 'gosai-test-'));

function makeManager(): { manager: DriverManager; bridge: StubBridge; bus: EventBus } {
  const bus = new EventBus();
  const logger = new Logger({ logsDir });
  const manifest: DriverManifestEntry[] = [
    { name: 'camera', events: ['color'], actions: [], dependencies: [] },
    { name: 'calibration', events: ['homography'], actions: [], dependencies: ['camera'] },
    { name: 'unrelated', events: ['tick'], actions: [], dependencies: [] },
    { name: 'speaker', events: ['level'], actions: [], dependencies: [], shared: true },
  ];
  const bridge = new StubBridge(manifest);
  const manager = new DriverManager({ pythonDir: '/dev/null', logger, bus });
  // Reach in and swap the bridge for the stub.
  (manager as unknown as { bridge: PythonBridge }).bridge = bridge as unknown as PythonBridge;
  bridge.onState = (instance, driver, state) => {
    (
      manager as unknown as {
        handleDriverState: (instance: string, driver: string, state: string) => void;
      }
    ).handleDriverState(instance, driver, state);
  };
  return { manager, bridge, bus };
}

const startsOf = (bridge: StubBridge, driver?: string): RecordedRequest[] =>
  bridge.events.filter((e) => e.type === 'start-driver' && (!driver || e.driver === driver));

const stopsOf = (bridge: StubBridge): Array<string | undefined> =>
  bridge.events.filter((e) => e.type === 'stop-driver').map((e) => e.driver);

describe('driver lifecycle', () => {
  test('starting a driver cascades dependencies', async () => {
    const { manager, bridge } = makeManager();
    await manager.start();
    bridge.events = [];

    await manager.subscribe(SYSTEM_BINDING, 'calibration', '*', 'expA');

    expect(startsOf(bridge).map((e) => e.driver)).toEqual(['camera', 'calibration']);
  });

  test('stopping the last subscriber releases dependencies', async () => {
    const { manager, bridge } = makeManager();
    await manager.start();
    bridge.events = [];

    await manager.subscribe(SYSTEM_BINDING, 'calibration', '*', 'expA');
    bridge.events = [];

    await manager.unsubscribe(SYSTEM_BINDING, 'calibration', '*', 'expA');
    expect(stopsOf(bridge)).toEqual(['calibration', 'camera']);
  });

  test('a dependency is kept alive by another subscriber in the same binding', async () => {
    const { manager, bridge } = makeManager();
    await manager.start();

    await manager.subscribe('appA', 'calibration', '*', 'expA');
    await manager.subscribe('appA', 'camera', '*', 'expB');
    bridge.events = [];

    await manager.unsubscribe('appA', 'calibration', '*', 'expA');
    expect(stopsOf(bridge)).toEqual(['calibration']);
    expect(manager.isInstanceRunning('appA', 'camera')).toBe(true);

    bridge.events = [];
    await manager.unsubscribe('appA', 'camera', '*', 'expB');
    expect(stopsOf(bridge)).toEqual(['camera']);
  });

  test('independent drivers do not affect each other', async () => {
    const { manager, bridge } = makeManager();
    await manager.start();

    await manager.subscribe('appA', 'calibration', '*', 'expA');
    await manager.subscribe('appA', 'unrelated', '*', 'expB');
    bridge.events = [];

    await manager.unsubscribe('appA', 'calibration', '*', 'expA');
    expect(stopsOf(bridge)).toEqual(['calibration', 'camera']);
    expect(manager.isInstanceRunning('appA', 'unrelated')).toBe(true);
  });

  test('exclusive drivers get one instance per binding', async () => {
    const { manager, bridge } = makeManager();
    await manager.start();
    bridge.events = [];

    await manager.subscribe('appA', 'camera', '*', 'a');
    await manager.subscribe('appB', 'camera', '*', 'b');

    // Two distinct camera instances, one per binding.
    const camStarts = startsOf(bridge, 'camera');
    expect(camStarts.map((e) => e.instance)).toEqual(['appA', 'appB']);
    expect(manager.isInstanceRunning('appA', 'camera')).toBe(true);
    expect(manager.isInstanceRunning('appB', 'camera')).toBe(true);

    // Stopping app A's camera leaves app B's running.
    bridge.events = [];
    await manager.unsubscribe('appA', 'camera', '*', 'a');
    const camStops = bridge.events.filter((e) => e.type === 'stop-driver' && e.driver === 'camera');
    expect(camStops.map((e) => e.instance)).toEqual(['appA']);
    expect(manager.isInstanceRunning('appA', 'camera')).toBe(false);
    expect(manager.isInstanceRunning('appB', 'camera')).toBe(true);
  });

  test('shared drivers collapse to a single instance across bindings', async () => {
    const { manager, bridge } = makeManager();
    await manager.start();
    bridge.events = [];

    await manager.subscribe('appA', 'speaker', '*', 'a');
    await manager.subscribe('appB', 'speaker', '*', 'b');

    // One physical speaker instance is shared by both apps.
    expect(startsOf(bridge, 'speaker')).toHaveLength(1);
    const info = manager.getDriver('speaker');
    expect(info?.shared).toBe(true);
    expect(info?.instances).toHaveLength(1);

    // The first app unsubscribing must not stop the shared instance.
    bridge.events = [];
    await manager.unsubscribe('appA', 'speaker', '*', 'a');
    expect(stopsOf(bridge)).toEqual([]);
    expect(manager.getDriver('speaker')?.state).toBe('running');

    bridge.events = [];
    await manager.unsubscribe('appB', 'speaker', '*', 'b');
    expect(stopsOf(bridge)).toEqual(['speaker']);
  });

  test('events fan out to every subscribing binding', async () => {
    const { manager, bus } = makeManager();
    await manager.start();

    await manager.subscribe('appA', 'speaker', '*', 'a');
    await manager.subscribe('appB', 'speaker', '*', 'b');

    const a: Array<Record<string, unknown>> = [];
    const b: Array<Record<string, unknown>> = [];
    bus.on('driver:event:appA', (_e, payload) => a.push(payload as Record<string, unknown>));
    bus.on('driver:event:appB', (_e, payload) => b.push(payload as Record<string, unknown>));

    // The shared speaker instance lives under the `shared` namespace.
    (
      manager as unknown as {
        handleDriverEvent: (
          instance: string,
          driver: string,
          event: string,
          data: unknown,
          ts: number,
        ) => void;
      }
    ).handleDriverEvent('shared', 'speaker', 'level', { rms: 0.5 }, 123);

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0]?.binding).toBe('appA');
    expect(b[0]?.binding).toBe('appB');
    expect(a[0]?.driver).toBe('speaker');
  });

  test('an exclusive instance never leaks events to another binding', async () => {
    const { manager, bus } = makeManager();
    await manager.start();

    await manager.subscribe('appA', 'camera', '*', 'a');

    const a: unknown[] = [];
    const b: unknown[] = [];
    bus.on('driver:event:appA', (_e, p) => a.push(p));
    bus.on('driver:event:appB', (_e, p) => b.push(p));

    (
      manager as unknown as {
        handleDriverEvent: (i: string, d: string, e: string, x: unknown, t: number) => void;
      }
    ).handleDriverEvent('appA', 'camera', 'color', {}, 1);

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(0);
  });

  test('driver runtime metadata is exposed on driver info', async () => {
    const { manager } = makeManager();
    await manager.start();

    (
      manager as unknown as {
        handleDriverState: (
          instance: string,
          driver: string,
          state: string,
          runtime?: {
            backend: string;
            provider: string;
            device: string;
            accelerated: boolean;
          },
        ) => void;
      }
    ).handleDriverState('appA', 'camera', 'running', {
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
});
