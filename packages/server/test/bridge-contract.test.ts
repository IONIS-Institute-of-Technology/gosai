/**
 * Contract test against the real Python bridge with the `heartbeat` driver.
 * Skipped when `python/.venv` has not been synced.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PythonBridge, type BridgeHandlers } from '../src/drivers/bridge.js';
import { DriverManager } from '../src/drivers/manager.js';
import { EventBus } from '../src/ipc/bus.js';
import { Logger } from '../src/logger/logger.js';

const PYTHON_DIR = resolve(import.meta.dir, '..', '..', '..', 'python');
const HAS_BRIDGE = existsSync(join(PYTHON_DIR, '.venv', 'bin', 'gosai-bridge'));
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

describe.skipIf(!HAS_BRIDGE)('python bridge contract', () => {
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
          drivers: Array<{ name: string; events: string[]; actions: string[] }>;
        }>({ type: 'list-drivers' }, { timeoutMs: TIMEOUT_MS });
        const heartbeat = catalogue.drivers.find((d) => d.name === 'heartbeat');
        expect(heartbeat?.events).toContain('tick');
        expect(heartbeat?.actions).toContain('echo');

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
