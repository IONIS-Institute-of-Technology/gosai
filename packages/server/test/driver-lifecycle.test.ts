/**
 * Driver lifecycle unit tests. Use a stubbed PythonBridge so the tests are
 * fast and don't require a real bridge.
 *
 * Verifies:
 * - Starting a driver also starts its dependencies.
 * - Stopping a driver releases its dependencies once nothing else needs them.
 * - A second active subscriber keeps a dependency running.
 */

import { describe, expect, test } from 'bun:test';
import { Logger } from '../src/logger/logger.js';
import { EventBus } from '../src/ipc/bus.js';
import { DriverManager, type DriverManifestEntry } from '../src/drivers/manager.js';
import type { PythonBridge } from '../src/drivers/bridge.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

class StubBridge {
  running = false;
  events: Array<{ type: string; driver?: string }> = [];
  manifest: readonly DriverManifestEntry[];

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

  async request<T = unknown>(req: { type: string; driver?: string; event?: string; action?: string; data?: unknown }): Promise<T> {
    this.events.push({ type: req.type, driver: req.driver });
    if (req.type === 'list-drivers') {
      return { drivers: this.manifest } as T;
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
  ];
  const bridge = new StubBridge(manifest);
  const manager = new DriverManager({ pythonDir: '/dev/null', logger, bus });
  // Reach in and swap the bridge for the stub.
  (manager as unknown as { bridge: PythonBridge }).bridge = bridge as unknown as PythonBridge;
  return { manager, bridge, bus };
}

describe('driver lifecycle', () => {
  test('starting a driver cascades dependencies', async () => {
    const { manager, bridge } = makeManager();
    await manager.start();
    bridge.events = [];

    await manager.subscribe('calibration', '*', 'expA');

    const starts = bridge.events.filter((e) => e.type === 'start-driver').map((e) => e.driver);
    expect(starts).toEqual(['camera', 'calibration']);
  });

  test('stopping the last subscriber releases dependencies', async () => {
    const { manager, bridge } = makeManager();
    await manager.start();
    bridge.events = [];

    await manager.subscribe('calibration', '*', 'expA');
    bridge.events = [];

    await manager.unsubscribe('calibration', '*', 'expA');
    const stops = bridge.events.filter((e) => e.type === 'stop-driver').map((e) => e.driver);
    expect(stops).toEqual(['calibration', 'camera']);
  });

  test('shared dependency is kept alive by other subscribers', async () => {
    const { manager, bridge } = makeManager();
    await manager.start();

    await manager.subscribe('calibration', '*', 'expA');
    await manager.subscribe('camera', '*', 'expB');
    bridge.events = [];

    await manager.unsubscribe('calibration', '*', 'expA');
    const stops = bridge.events.filter((e) => e.type === 'stop-driver').map((e) => e.driver);
    expect(stops).toEqual(['calibration']);
    expect(manager.getDriver('camera')?.state).toBe('running');

    bridge.events = [];
    await manager.unsubscribe('camera', '*', 'expB');
    const stops2 = bridge.events.filter((e) => e.type === 'stop-driver').map((e) => e.driver);
    expect(stops2).toEqual(['camera']);
  });

  test('independent drivers do not affect each other', async () => {
    const { manager, bridge } = makeManager();
    await manager.start();

    await manager.subscribe('calibration', '*', 'expA');
    await manager.subscribe('unrelated', '*', 'expB');
    bridge.events = [];

    await manager.unsubscribe('calibration', '*', 'expA');
    const stops = bridge.events.filter((e) => e.type === 'stop-driver').map((e) => e.driver);
    expect(stops).toEqual(['calibration', 'camera']);
    expect(manager.getDriver('unrelated')?.state).toBe('running');
  });
});
