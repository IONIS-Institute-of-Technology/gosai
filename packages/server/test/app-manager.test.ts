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

  async subscribe(
    binding: string,
    driver: string,
    event: string,
    subscriber: string,
  ): Promise<void> {
    this.subscribes.push({ binding, driver, event, subscriber });
  }

  async unsubscribe(
    binding: string,
    driver: string,
    event: string,
    subscriber: string,
  ): Promise<void> {
    this.unsubscribes.push({ binding, driver, event, subscriber });
  }
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
    expect('driverBinding' in (running[0] as Record<string, unknown>)).toBe(false);

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
