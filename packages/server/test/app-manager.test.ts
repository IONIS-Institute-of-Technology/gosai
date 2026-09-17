import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { AppManager } from '../src/apps/manager.js';
import type { DriverManager } from '../src/drivers/manager.js';
import { EventBus } from '../src/ipc/bus.js';
import { Logger } from '../src/logger/logger.js';

interface DriverCall {
  readonly binding: string;
  readonly driver: string;
  readonly event: string;
  readonly subscriber: string;
}

class StubDrivers {
  readonly subscribes: DriverCall[] = [];
  readonly unsubscribes: DriverCall[] = [];
  /** Live leases per driver, counted like DriverManager does. */
  readonly leases = new Map<string, number>();
  readonly failing = new Set<string>();

  async subscribe(
    binding: string,
    driver: string,
    event: string,
    subscriber: string,
  ): Promise<void> {
    this.subscribes.push({ binding, driver, event, subscriber });
    if (this.failing.has(driver)) throw new Error(`${driver} failed to start`);
    this.leases.set(driver, (this.leases.get(driver) ?? 0) + 1);
  }

  async unsubscribe(
    binding: string,
    driver: string,
    event: string,
    subscriber: string,
  ): Promise<void> {
    this.unsubscribes.push({ binding, driver, event, subscriber });
    const count = this.leases.get(driver) ?? 0;
    if (count <= 1) this.leases.delete(driver);
    else this.leases.set(driver, count - 1);
  }
}

function makePaths(): { root: string; apps: string; logs: string; data: string; config: string } {
  const tmp = mkdtempSync(join(tmpdir(), 'gosai-app-manager-'));
  const paths = {
    root: tmp,
    apps: join(tmp, 'apps'),
    logs: join(tmp, 'logs'),
    data: join(tmp, 'data'),
    config: join(tmp, 'config'),
  };
  for (const dir of Object.values(paths)) mkdirSync(dir, { recursive: true });
  return paths;
}

describe('app manager', () => {
  test('starts declared drivers with an overridden driver binding', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'gosai-app-manager-'));
    const paths = {
      root: tmp,
      apps: join(tmp, 'apps'),
      logs: join(tmp, 'logs'),
      data: join(tmp, 'data'),
      config: join(tmp, 'config'),
    };
    for (const dir of Object.values(paths)) mkdirSync(dir, { recursive: true });
    writeApp(paths.apps, 'calibration', 'calibrate', ['camera', 'calibration']);
    writeApp(paths.apps, 'interactive-pool', 'main', []);

    const drivers = new StubDrivers();
    const manager = new AppManager({
      paths,
      logger: new Logger({ logsDir: paths.logs }),
      bus: new EventBus(),
      drivers: drivers as unknown as DriverManager,
    });

    await manager.startExperience('calibration', 'calibrate', {
      driverBinding: 'interactive-pool',
    });

    expect(drivers.subscribes).toEqual([
      {
        binding: 'interactive-pool',
        driver: 'camera',
        event: '*',
        subscriber: 'calibration::calibrate',
      },
      {
        binding: 'interactive-pool',
        driver: 'calibration',
        event: '*',
        subscriber: 'calibration::calibrate',
      },
    ]);

    const running = manager.listRunningExperiences();
    expect(running).toHaveLength(1);
    expect(running[0]?.appSlug).toBe('calibration');
    expect(running[0]?.experienceSlug).toBe('calibrate');
    expect(running[0]?.state).toBe('running');
    expect(running[0]).not.toHaveProperty('driverBinding');

    await manager.stopExperience('calibration', 'calibrate');

    expect(drivers.unsubscribes).toEqual([
      {
        binding: 'interactive-pool',
        driver: 'camera',
        event: '*',
        subscriber: 'calibration::calibrate',
      },
      {
        binding: 'interactive-pool',
        driver: 'calibration',
        event: '*',
        subscriber: 'calibration::calibrate',
      },
    ]);
  });

  test('a failed start releases the drivers it took, and retries do not pile up', async () => {
    const paths = makePaths();
    writeApp(paths.apps, 'pool', 'main', ['camera', 'calibration']);
    const drivers = new StubDrivers();
    drivers.failing.add('calibration');
    const manager = new AppManager({
      paths,
      logger: new Logger({ logsDir: paths.logs }),
      bus: new EventBus(),
      drivers: drivers as unknown as DriverManager,
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(manager.startExperience('pool', 'main')).rejects.toThrow(
        'calibration failed to start',
      );
      expect(drivers.leases.size).toBe(0);
      expect(manager.listRunningExperiences()[0]?.state).toBe('crashed');
    }

    drivers.failing.clear();
    await manager.startExperience('pool', 'main');
    expect(Object.fromEntries(drivers.leases)).toEqual({ camera: 1, calibration: 1 });

    await manager.stopExperience('pool', 'main');
    expect(drivers.leases.size).toBe(0);
    expect(manager.listRunningExperiences()).toEqual([]);
  });
});

function writeApp(
  appsDir: string,
  slug: string,
  experienceSlug: string,
  drivers: readonly string[],
): void {
  const appDir = join(appsDir, slug);
  mkdirSync(appDir, { recursive: true });
  writeFileSync(
    join(appDir, 'gosai.app.json'),
    JSON.stringify(
      {
        slug,
        name: slug,
        version: '0.0.0',
        experiences: [
          {
            slug: experienceSlug,
            name: experienceSlug,
            entry: 'dist/main.js',
            drivers,
            exclusive: true,
          },
        ],
      },
      null,
      2,
    ),
    'utf8',
  );
}
