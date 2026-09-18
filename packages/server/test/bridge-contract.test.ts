/**
 * Contract tests against the real Python bridge with the `heartbeat` driver,
 * and against an app's bridge with a tiny app driver next to it. Skipped when
 * `python/.venv` has not been synced; the app tests also need uv. The JS CI
 * job syncs both, so there they must run.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DriverSchema } from '@gosai/shared';
import { pythonAppBridges } from '../src/drivers/app-drivers.js';
import { PythonBridge, type BridgeHandlers } from '../src/drivers/bridge.js';
import { DriverHub, type AppDriverSource } from '../src/drivers/hub.js';
import { DriverManager } from '../src/drivers/manager.js';
import { EventBus } from '../src/ipc/bus.js';
import { Logger } from '../src/logger/logger.js';
import {
  COUNTER_DRIVER,
  HAS_PYTHON_ENV,
  HAS_UV,
  writeDriverPackage,
  writeTinyWheel,
} from './python-fixtures.js';

const PYTHON_DIR = resolve(import.meta.dir, '..', '..', '..', 'python');
const TIMEOUT_MS = 120_000;

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 20));
  }
}

function newLogger(): Logger {
  return new Logger({ logsDir: mkdtempSync(join(tmpdir(), 'gosai-contract-')) });
}

test.if(Boolean(process.env.CI))('CI provides python/.venv and uv', () => {
  expect({ venv: HAS_PYTHON_ENV, uv: HAS_UV }).toEqual({ venv: true, uv: true });
});

describe.skipIf(!HAS_PYTHON_ENV)('python bridge contract', () => {
  test(
    'heartbeat round trip',
    async () => {
      const events: Array<{ instance: string; event: string; data: unknown; ts: number }> = [];
      const states: string[] = [];
      const exits: Array<number | null> = [];
      const handlers: BridgeHandlers = {
        onEvent: (instance, _driver, event, data, ts) => events.push({ instance, event, data, ts }),
        onLog: () => undefined,
        onDriverState: (_instance, driver, state) => {
          if (driver === 'heartbeat') states.push(state);
        },
        onPerformance: () => undefined,
        onExit: (code) => exits.push(code),
      };
      const bridge = new PythonBridge({
        pythonDir: PYTHON_DIR,
        logger: newLogger().child('bridge'),
        handlers,
      });

      await bridge.start();
      try {
        expect(await bridge.ping(5_000)).toBeGreaterThanOrEqual(0);
        const catalogue = await bridge.request<{
          drivers: Array<{
            name: string;
            events: string[];
            actions: string[];
            schema: DriverSchema;
          }>;
        }>({ type: 'list-drivers' }, { timeoutMs: TIMEOUT_MS });
        const heartbeat = catalogue.drivers.find((d) => d.name === 'heartbeat');
        expect(heartbeat?.events).toContain('tick');
        expect(heartbeat?.actions).toContain('echo');
        expect(heartbeat?.schema.events['tick']?.payload).toEqual({ $ref: '#/$defs/TickPayload' });
        expect(heartbeat?.schema.$defs['TickPayload']).toMatchObject({
          required: ['count', 'now'],
        });

        const started = await bridge.request({
          type: 'start-driver',
          instance: 'contract',
          driver: 'heartbeat',
        });
        expect(started).toEqual({ driver: 'heartbeat', state: 'running' });
        await waitFor(() => states.includes('running'));
        expect(states).toEqual(['starting', 'running']);

        await bridge.request({
          type: 'subscribe',
          instance: 'contract',
          driver: 'heartbeat',
          event: 'tick',
        });
        await waitFor(() => events.length > 0);
        expect(events[0]?.instance).toBe('contract');
        expect(events[0]?.event).toBe('tick');
        expect(Math.abs((events[0]?.ts ?? 0) - Date.now())).toBeLessThan(60_000);

        const echoed = await bridge.request<{ echoed: unknown }>({
          type: 'execute',
          instance: 'contract',
          driver: 'heartbeat',
          action: 'echo',
          data: { hello: 'world' },
        });
        expect(echoed.echoed).toEqual({ hello: 'world' });
        await expect(
          bridge.request({
            type: 'execute',
            instance: 'contract',
            driver: 'heartbeat',
            action: 'nope',
          }),
        ).rejects.toThrow("does not support action 'nope'");

        await bridge.request({ type: 'stop-driver', instance: 'contract', driver: 'heartbeat' });
        await waitFor(() => states.includes('available'));
        expect(states.slice(-2)).toEqual(['stopping', 'available']);
        const listed = await bridge.request<{ instances: unknown[] }>({ type: 'list-instances' });
        expect(listed.instances).toEqual([]);
      } finally {
        await bridge.stop();
      }
      expect(exits).toEqual([0]);
      expect(bridge.isRunning()).toBe(false);
    },
    TIMEOUT_MS,
  );

  test(
    'leases start and stop drivers in the real bridge',
    async () => {
      const bus = new EventBus();
      const manager = new DriverManager({ pythonDir: PYTHON_DIR, logger: newLogger(), bus });
      const ticks: unknown[] = [];
      bus.on('driver:event:contract', (_e, payload) => ticks.push(payload));

      await manager.start();
      try {
        await manager.subscribe('contract', 'heartbeat', 'tick', 'client');
        expect(manager.getDriver('heartbeat')?.state).toBe('running');
        await waitFor(() => ticks.length > 0);

        await manager.unsubscribe('contract', 'heartbeat', 'tick', 'client');
        expect(manager.getDriver('heartbeat')?.state).toBe('available');
      } finally {
        await manager.stop();
      }
    },
    TIMEOUT_MS,
  );
});

describe.skipIf(!HAS_PYTHON_ENV || !HAS_UV)('app driver bridge contract', () => {
  interface DriverEvent {
    readonly driver: string;
    readonly event: string;
    readonly data: { count?: number };
  }

  async function startHub(): Promise<{
    hub: DriverHub;
    events: DriverEvent[];
    appDir: string;
    root: string;
  }> {
    const root = mkdtempSync(join(tmpdir(), 'gosai-app-contract-'));
    const appDir = join(root, 'apps', 'contract-app');
    const python = writeDriverPackage(appDir, { 'counter.py': COUNTER_DRIVER }, 'contract_drivers');
    const wheel = writeTinyWheel(join(appDir, 'vendor'));
    writeFileSync(join(appDir, 'requirements.txt'), `${wheel}\n`);
    const data = join(root, 'data');
    mkdirSync(data);
    const app: AppDriverSource = {
      slug: 'contract-app',
      installPath: appDir,
      builtin: false,
      python: { ...python, requirements: 'requirements.txt' },
    };
    const logger = newLogger();
    const bus = new EventBus();
    const hub = new DriverHub({
      pythonDir: PYTHON_DIR,
      logger,
      bus,
      apps: pythonAppBridges({
        toolchain: { pythonDir: PYTHON_DIR, uv: 'uv' },
        paths: { root, data },
        logger,
      }),
      supervisorTiming: { initialBackoffMs: 50 },
    });
    const events: DriverEvent[] = [];
    bus.on('driver:event:contract', (_event, payload) => events.push(payload as DriverEvent));
    hub.sync([app]);
    await hub.start();
    return { hub, events, appDir, root };
  }

  test(
    'an app bridge runs its drivers next to the built-in bridge',
    async () => {
      const { hub, events, appDir, root } = await startHub();
      try {
        await hub.subscribe('contract', 'heartbeat', 'tick', 'client');
        await hub.subscribe('contract', 'contract-app/counter', 'count', 'client');
        // Bytecode goes to the environment: the app directory may be a signed bundle.
        const pycache = join(root, 'python-envs', 'installed', 'contract-app', 'pycache');
        expect(existsSync(pycache)).toBe(true);
        expect(existsSync(join(appDir, 'python', 'contract_drivers', '__pycache__'))).toBe(false);
        await waitFor(
          () =>
            events.some((e) => e.driver === 'heartbeat') &&
            events.some((e) => e.driver === 'contract-app/counter' && e.event === 'count'),
          30_000,
        );

        // The driver runs in the app's environment, with its requirement installed.
        expect(await hub.execute('contract', 'contract-app/counter', 'where', null)).toEqual({
          slug: 'contract-app',
          tinydep: 42,
        });
        expect(hub.listDrivers().map((d) => d.name)).toContain('contract-app/counter');
        const schema = hub.getSchemas('contract-app/counter').schemas['contract-app/counter'];
        expect(schema?.schema?.events['count']?.payload).toEqual({ $ref: '#/$defs/Count' });
        expect(hub.getDriver('contract-app/counter')?.schemaVersion).toMatch(/^[0-9a-f]{16}$/);

        await hub.unsubscribe('contract', 'contract-app/counter', 'count', 'client');
        expect(hub.getDriver('contract-app/counter')?.state).toBe('available');
        expect(hub.getDriver('heartbeat')?.state).toBe('running');
      } finally {
        await hub.stop();
      }
    },
    TIMEOUT_MS,
  );

  test(
    'a crashing app bridge restarts while built-in drivers keep running',
    async () => {
      const { hub, events } = await startHub();
      try {
        await hub.subscribe('contract', 'heartbeat', 'tick', 'client');
        await hub.subscribe('contract', 'contract-app/counter', 'count', 'client');
        // Far enough that a restarted process, which counts from 1 again, is told apart.
        await waitFor(
          () => events.some((e) => e.driver === 'contract-app/counter' && (e.data.count ?? 0) >= 5),
          30_000,
        );

        await expect(
          hub.execute('contract', 'contract-app/counter', 'crash', null),
        ).rejects.toThrow();
        const ticksAtCrash = events.filter((e) => e.driver === 'heartbeat').length;

        // The supervisor restarts the app bridge and applies the lease again: a
        // new process counts from the start.
        const counts = (): number[] =>
          events.filter((e) => e.driver === 'contract-app/counter').map((e) => e.data.count ?? 0);
        const before = counts().length;
        await waitFor(
          () => counts().some((count, i) => i >= before && count < counts()[i - 1]!),
          30_000,
        );
        await waitFor(
          () => events.filter((e) => e.driver === 'heartbeat').length > ticksAtCrash + 1,
          10_000,
        );
        expect(hub.getDriver('heartbeat')?.state).toBe('running');
        expect(hub.getDriver('contract-app/counter')?.state).toBe('running');
      } finally {
        await hub.stop();
      }
    },
    TIMEOUT_MS,
  );
});
