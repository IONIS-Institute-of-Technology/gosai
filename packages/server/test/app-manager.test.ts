import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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
      // A failed start doesn't stay in the running list.
      expect(manager.listRunningExperiences()).toEqual([]);
    }

    drivers.failing.clear();
    await manager.startExperience('pool', 'main');
    expect(Object.fromEntries(drivers.leases)).toEqual({ camera: 1, calibration: 1 });

    await manager.stopExperience('pool', 'main');
    expect(drivers.leases.size).toBe(0);
    expect(manager.listRunningExperiences()).toEqual([]);
  });
});

describe('app manager lifecycle', () => {
  function manifestApp(dir: string, manifest: Record<string, unknown>): void {
    const appDir = join(dir, String(manifest.slug));
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(appDir, 'gosai.app.json'), JSON.stringify(manifest));
  }

  function setup(): {
    paths: ReturnType<typeof makePaths>;
    drivers: StubDrivers;
    bus: EventBus;
    create(builtinAppsDir?: string): AppManager;
  } {
    const paths = makePaths();
    const drivers = new StubDrivers();
    const bus = new EventBus();
    return {
      paths,
      drivers,
      bus,
      create: (builtinAppsDir) =>
        new AppManager({
          paths,
          logger: new Logger({ logsDir: paths.logs }),
          bus,
          drivers: drivers as unknown as DriverManager,
          ...(builtinAppsDir ? { builtinAppsDir } : {}),
        }),
    };
  }

  const chain = {
    slug: 'pool',
    name: 'Pool',
    version: '1.0.0',
    experiences: [
      { slug: 'main', name: 'Main', entry: 'main.js', drivers: ['hand_pose'], required: ['base'] },
      { slug: 'base', name: 'Base', entry: 'base.js', drivers: ['camera'] },
    ],
  };

  test('starts required experiences first and rolls them back when the start fails', async () => {
    const { paths, drivers, create } = setup();
    manifestApp(paths.apps, chain);
    const manager = create();

    await manager.startExperience('pool', 'main');
    expect(drivers.subscribes.map((c) => c.driver)).toEqual(['camera', 'hand_pose']);
    expect(
      manager
        .listRunningExperiences()
        .map((e) => e.experienceSlug)
        .sort(),
    ).toEqual(['base', 'main']);
    await manager.stopExperience('pool', 'main');
    await manager.stopExperience('pool', 'base');

    drivers.failing.add('hand_pose');
    await expect(manager.startExperience('pool', 'main')).rejects.toThrow('hand_pose');
    expect(manager.listRunningExperiences()).toEqual([]);
    expect(drivers.leases.size).toBe(0);
  });

  test('keeps a required experience that was already running when a start fails', async () => {
    const { paths, drivers, create } = setup();
    manifestApp(paths.apps, chain);
    const manager = create();
    await manager.startExperience('pool', 'base');
    drivers.failing.add('hand_pose');
    await expect(manager.startExperience('pool', 'main')).rejects.toThrow();
    expect(manager.listRunningExperiences().map((e) => e.experienceSlug)).toEqual(['base']);
  });

  test('publishes a crashed state for a failed start', async () => {
    const { paths, drivers, bus, create } = setup();
    manifestApp(paths.apps, chain);
    const manager = create();
    const states: string[] = [];
    bus.on('experience:state-changed', (_event, payload) => {
      const state = payload as { experienceSlug: string; state: string };
      states.push(`${state.experienceSlug}:${state.state}`);
    });
    drivers.failing.add('camera');
    await expect(manager.startExperience('pool', 'base')).rejects.toThrow();
    expect(states).toEqual(['base:starting', 'base:crashed']);
    expect(manager.getApp('pool')?.state).toBe('crashed');
  });

  test('auto-starts the startup experiences, or the default one', async () => {
    const { paths, create } = setup();
    manifestApp(paths.apps, { ...chain, startup: ['base'] });
    manifestApp(paths.apps, {
      slug: 'other',
      name: 'Other',
      version: '1.0.0',
      default: 'second',
      experiences: [
        { slug: 'first', name: 'First', entry: 'first.js' },
        { slug: 'second', name: 'Second', entry: 'second.js' },
      ],
    });
    const manager = create();
    await manager.autoStart(['pool', 'other', 'ghost']);
    expect(
      manager
        .listRunningExperiences()
        .map((e) => `${e.appSlug}/${e.experienceSlug}`)
        .sort(),
    ).toEqual(['other/second', 'pool/base']);
  });

  test('marks apps built-in by where they were found, and keeps data on uninstall', async () => {
    const { paths, create } = setup();
    const builtin = join(paths.root, 'builtin');
    manifestApp(builtin, { ...chain, slug: 'shipped' });
    manifestApp(paths.apps, chain);
    const manager = create(builtin);
    expect(manager.getApp('shipped')?.builtin).toBe(true);
    expect(manager.getApp('pool')).toMatchObject({ builtin: false, source: 'git' });
    expect(manager.getApp('pool')).not.toHaveProperty('installPath');
    await expect(manager.uninstall('shipped')).rejects.toThrow('built-in');

    const dataFile = join(paths.data, 'pool', 'storage', 'score.json');
    mkdirSync(join(paths.data, 'pool', 'storage'), { recursive: true });
    writeFileSync(dataFile, '1');
    expect(await manager.uninstall('pool')).toBe(false);
    expect(existsSync(join(paths.apps, 'pool'))).toBe(false);
    expect(existsSync(dataFile)).toBe(true);

    manifestApp(paths.apps, chain);
    manager.discover();
    expect(await manager.uninstall('pool', { deleteData: true })).toBe(true);
    expect(existsSync(join(paths.data, 'pool'))).toBe(false);
  });

  test('keeps the crashed state when a failed start rolls back its requirements', async () => {
    const { paths, drivers, create } = setup();
    manifestApp(paths.apps, chain);
    const manager = create();
    drivers.failing.add('hand_pose');
    await expect(manager.startExperience('pool', 'main')).rejects.toThrow();
    expect(manager.getApp('pool')?.state).toBe('crashed');
    drivers.failing.clear();
    await manager.startExperience('pool', 'base');
    expect(manager.getApp('pool')?.state).toBe('running');
  });

  test('grants built-in apps their requested capabilities and installed apps only approved ones', () => {
    const { paths, create } = setup();
    const builtin = join(paths.root, 'builtin');
    const requesting = { ...chain, capabilities: ['logs:read', 'devices:read'] };
    manifestApp(builtin, { ...requesting, slug: 'shipped' });
    manifestApp(paths.apps, requesting);
    const manager = create(builtin);
    expect(manager.grantedCapabilities('shipped')).toEqual(['logs:read', 'devices:read']);
    expect(manager.grantedCapabilities('pool')).toEqual([]);

    // Approving something the manifest doesn't request grants nothing extra.
    const approved = manager.approveCapabilities('pool', ['devices:read', 'app-config:write']);
    expect(approved.grantedCapabilities).toEqual(['devices:read']);
    expect(manager.grantedCapabilities('pool')).toEqual(['devices:read']);
    expect(() => manager.approveCapabilities('shipped', [])).toThrow('Built-in');
    // The approval survives a restart.
    expect(create(builtin).grantedCapabilities('pool')).toEqual(['devices:read']);
  });

  test('an invalid installed app that shadows a built-in one stays listed and uninstalls', async () => {
    const { paths, create } = setup();
    const builtin = join(paths.root, 'builtin');
    manifestApp(builtin, chain);
    manifestApp(paths.apps, { ...chain, sdk: '^99.0.0' });
    const manager = create(builtin);

    // The built-in app keeps working; the installed one is listed with the reason.
    expect(manager.getApp('pool')?.builtin).toBe(true);
    expect(manager.listInvalidApps()).toEqual([
      { slug: 'pool', builtin: false, error: expect.stringContaining('needs @gosai/sdk ^99.0.0') },
    ]);

    expect(await manager.uninstall('pool')).toBe(false);
    expect(existsSync(join(paths.apps, 'pool'))).toBe(false);
    expect(manager.listInvalidApps()).toEqual([]);
    expect(manager.getApp('pool')?.builtin).toBe(true);
    await expect(manager.uninstall('pool')).rejects.toThrow('Cannot uninstall built-in app pool');
  });

  test('uninstalling an installed app that shadows a built-in one brings the built-in back', async () => {
    const { paths, create } = setup();
    const builtin = join(paths.root, 'builtin');
    manifestApp(builtin, { ...chain, name: 'Shipped pool' });
    manifestApp(paths.apps, { ...chain, name: 'Installed pool' });
    const manager = create(builtin);
    expect(manager.getApp('pool')).toMatchObject({ builtin: false });

    await manager.uninstall('pool');
    expect(manager.getApp('pool')).toMatchObject({ builtin: true });
    expect(manager.getManifest('pool')?.name).toBe('Shipped pool');
  });

  test('stops experiences of any app that use drivers being replaced or removed', async () => {
    const paths = makePaths();
    const builtin = join(paths.root, 'builtin');
    const python = { drivers: 'python/pool_drivers' };
    const app = (slug: string, drivers: string[], extra: object = {}) => ({
      slug,
      name: slug,
      version: '1.0.0',
      experiences: [{ slug: 'main', name: 'Main', entry: 'main.js', drivers }],
      ...extra,
    });
    manifestApp(builtin, app('pool', ['pool/counter'], { python }));
    manifestApp(paths.apps, app('user', ['camera', 'pool/counter']));
    manifestApp(paths.apps, app('plain', ['camera']));
    const calls: string[] = [];
    const bus = new EventBus();
    const states: string[] = [];
    bus.on('experience:state-changed', (_event, payload) => {
      const { appSlug, state } = payload as { appSlug: string; state: string };
      states.push(`${appSlug}:${state}`);
    });
    const manager = new AppManager({
      paths,
      logger: new Logger({ logsDir: paths.logs }),
      bus,
      drivers: new StubDrivers() as unknown as DriverManager,
      builtinAppsDir: builtin,
      appDrivers: {
        sync: (apps) =>
          calls.push(`sync ${apps.map((a) => `${a.slug}:${a.builtin}:${a.installPath}`).join()}`),
        release: async (slug) => {
          const running = manager.listRunningExperiences().map((e) => e.appSlug);
          calls.push(`release ${slug} while [${running.join()}] run`);
        },
      },
    });
    await waitFor(() => calls.length === 1);
    expect(calls).toEqual([`sync pool:true:${join(builtin, 'pool')}`]);
    const running = (): string[] =>
      manager.listRunningExperiences().map((e) => `${e.appSlug}:${e.state}`);

    // An installed pool replaces the built-in one while other apps use its drivers.
    await manager.startExperience('user', 'main');
    await manager.startExperience('pool', 'main');
    await manager.startExperience('plain', 'main');
    states.length = 0;
    manifestApp(paths.apps, app('pool', ['pool/counter'], { python }));
    manager.discover();
    await waitFor(() => calls.length === 3);
    expect(calls.slice(1)).toEqual([
      'release pool while [plain] run',
      `sync pool:false:${join(paths.apps, 'pool')}`,
    ]);
    expect(running()).toEqual(['plain:running']);
    expect(states).toEqual(expect.arrayContaining(['user:idle', 'pool:idle']));

    // Uninstalling it stops them again before its files go.
    await manager.startExperience('user', 'main');
    await manager.uninstall('pool');
    await waitFor(() => calls.length === 5);
    expect(calls.slice(3)).toEqual([
      'release pool while [plain] run',
      `sync pool:true:${join(builtin, 'pool')}`,
    ]);
    expect(running()).toEqual(['plain:running']);

    // Nothing changes for apps whose drivers stay.
    manager.discover();
    await manager.startExperience('user', 'main');
    await Bun.sleep(20);
    expect(calls).toHaveLength(5);
    expect(running()).toEqual(['plain:running', 'user:running']);
  });

  test('lists apps with an invalid manifest and can still uninstall them', async () => {
    const { paths } = setup();
    manifestApp(paths.apps, { ...chain, slug: 'broken', experiences: [] });
    manifestApp(paths.apps, { ...chain, builtin: false, homepage: 'https://example.com' });
    const logger = new Logger({ logsDir: paths.logs });
    const bus = new EventBus();
    const manager = new AppManager({
      paths,
      logger,
      bus,
      drivers: new StubDrivers() as unknown as DriverManager,
    });
    // Old and unknown fields only warn.
    expect(manager.getApp('pool')).toBeDefined();
    expect(logger.history().some((entry) => entry.message.includes('homepage'))).toBe(true);

    expect(manager.getApp('broken')).toBeUndefined();
    expect(manager.listInvalidApps()).toEqual([
      { slug: 'broken', builtin: false, error: expect.stringContaining('experiences') },
    ]);
    expect(await manager.uninstall('broken')).toBe(false);
    expect(existsSync(join(paths.apps, 'broken'))).toBe(false);
    expect(manager.listInvalidApps()).toEqual([]);
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

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
