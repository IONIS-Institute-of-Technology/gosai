import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import type { AppManifest } from '@gosai/shared';
import { migrateLegacyAppData } from '../src/apps/data-migration.js';
import { AppSettingsValuesStore } from '../src/apps/settings.js';
import { AppStorage } from '../src/apps/storage.js';
import { AppSettingsStore } from '../src/config/app-settings.js';
import { ConfigStore, loadGlobalConfig } from '../src/config/config.js';
import { EventBus } from '../src/ipc/bus.js';
import { Logger } from '../src/logger/logger.js';

function tempPaths(): { root: string; apps: string; data: string; config: string; logs: string } {
  const root = mkdtempSync(join(tmpdir(), 'gosai-stores-'));
  const paths = {
    root,
    apps: join(root, 'apps'),
    data: join(root, 'data'),
    config: join(root, 'config'),
    logs: join(root, 'logs'),
  };
  for (const dir of Object.values(paths)) mkdirSync(dir, { recursive: true });
  return paths;
}

function recordEvents(bus: EventBus): Array<{ event: string; payload: unknown }> {
  const events: Array<{ event: string; payload: unknown }> = [];
  bus.on('*', (event, payload) => events.push({ event, payload }));
  return events;
}

describe('AppStorage', () => {
  test('stores JSON values per app under the data directory', () => {
    const paths = tempPaths();
    const storage = new AppStorage(paths);
    expect(storage.get('pool', 'score')).toEqual({ found: false });
    storage.set('pool', 'score', { best: 3 });
    storage.set('pool', 'empty', null);
    expect(storage.get('pool', 'score')).toEqual({ found: true, value: { best: 3 } });
    expect(storage.get('pool', 'empty')).toEqual({ found: true, value: null });
    expect(storage.list('pool')).toEqual(['empty', 'score']);
    expect(storage.list('other')).toEqual([]);
    expect(existsSync(join(paths.data, 'pool', 'storage', 'score.json'))).toBe(true);
    expect(storage.remove('pool', 'score')).toBe(true);
    expect(storage.remove('pool', 'score')).toBe(false);
  });

  test('reports a corrupt value instead of pretending it is missing', () => {
    const paths = tempPaths();
    const storage = new AppStorage(paths);
    mkdirSync(join(paths.data, 'pool', 'storage'), { recursive: true });
    writeFileSync(join(paths.data, 'pool', 'storage', 'broken.json'), '{nope');
    expect(() => storage.get('pool', 'broken')).toThrow('corrupt');
  });

  test('rejects keys and slugs that could leave the directory', () => {
    const storage = new AppStorage(tempPaths());
    expect(() => storage.set('pool', '../x', 1)).toThrow('Invalid storage key');
    expect(() => storage.set('pool', 'a/b', 1)).toThrow('Invalid storage key');
    expect(() => storage.get('../pool', 'k')).toThrow();
  });
});

describe('ConfigStore', () => {
  test('fills in defaults, merges patches and publishes changes', () => {
    const paths = tempPaths();
    writeFileSync(
      join(paths.config, 'global.json'),
      JSON.stringify({ displayId: 2, camera: { device: 1 }, unknown: true }),
    );
    const bus = new EventBus();
    const events = recordEvents(bus);
    const store = new ConfigStore(
      paths.config,
      bus,
      new Logger({ logsDir: paths.logs }).child('t'),
    );
    expect(store.get()).toEqual({
      displayId: 2,
      serverPort: 7777,
      autoStartApps: [],
      camera: { device: 1, width: 1280, height: 720, fps: 30 },
    });

    const next = store.update({ camera: { fps: 60 }, autoStartApps: ['pool'], displayId: null });
    expect(next.camera).toEqual({ device: 1, width: 1280, height: 720, fps: 60 });
    expect(next.displayId).toBeNull();
    expect(events).toEqual([{ event: 'server:config-changed', payload: next }]);
    expect(loadGlobalConfig(paths.config).config).toEqual(next);
    expect(readFileSync(join(paths.config, 'global.json'), 'utf8')).not.toContain('unknown');
  });

  test('uses the defaults for an invalid file and says why', () => {
    const paths = tempPaths();
    writeFileSync(join(paths.config, 'global.json'), JSON.stringify({ serverPort: 'x' }));
    const loaded = loadGlobalConfig(paths.config);
    expect(loaded.config.serverPort).toBe(7777);
    expect(loaded.problem).toContain('serverPort');
    writeFileSync(join(paths.config, 'global.json'), '{');
    expect(loadGlobalConfig(paths.config).problem).toContain('invalid JSON');
  });
});

describe('AppSettingsStore (device settings)', () => {
  test('merges patches, clears overrides with null and publishes changes', () => {
    const paths = tempPaths();
    const bus = new EventBus();
    const events = recordEvents(bus);
    const logger = new Logger({ logsDir: paths.logs });
    const store = new AppSettingsStore(paths, bus, logger.child('t'));

    store.update('pool', { camera: { device: 2, fps: 60 }, display: { id: 5, mode: 'windowed' } });
    expect(store.update('pool', { camera: { device: null } })).toEqual({
      camera: { fps: 60 },
      display: { id: 5, mode: 'windowed' },
    });
    expect(store.update('pool', { display: null, camera: { fps: null } })).toEqual({});
    expect(events.at(-1)).toEqual({
      event: 'app:config-changed',
      payload: { appSlug: 'pool', settings: {} },
    });

    store.update('pool', { microphone: { device: 3 } });
    const reloaded = new AppSettingsStore(paths, new EventBus(), logger.child('t'));
    expect(reloaded.get('pool')).toEqual({ microphone: { device: 3 } });
    expect(existsSync(join(paths.data, 'pool', 'device-settings.json'))).toBe(true);
  });

  test('ignores an invalid settings file', () => {
    const paths = tempPaths();
    mkdirSync(join(paths.data, 'pool'), { recursive: true });
    writeFileSync(
      join(paths.data, 'pool', 'device-settings.json'),
      JSON.stringify({ camera: { device: 'front' } }),
    );
    const logger = new Logger({ logsDir: paths.logs });
    const store = new AppSettingsStore(paths, new EventBus(), logger.child('t'));
    expect(store.get('pool')).toEqual({});
    expect(logger.history().at(-1)?.message).toContain('invalid');
  });
});

describe('AppSettingsValuesStore (declared settings)', () => {
  const manifest: AppManifest = {
    slug: 'mirror',
    name: 'Mirror',
    version: '1.0.0',
    experiences: [{ slug: 'main', name: 'Main', entry: 'main.js', drivers: [], exclusive: false }],
    settings: {
      groups: [
        {
          label: 'Projection',
          fields: [
            {
              key: 'projection.mode',
              label: 'Mode',
              type: 'select',
              default: 'direct',
              options: [
                { value: 'direct', label: 'Direct' },
                { value: 'reflection', label: 'Reflection' },
              ],
            },
            { key: 'projection.mirror', label: 'Mirror', type: 'boolean', default: true },
            { key: 'zoom', label: 'Zoom', type: 'number', min: 0.5, max: 2 },
          ],
        },
      ],
    },
  };

  function setup(): { store: AppSettingsValuesStore; storage: AppStorage; bus: EventBus } {
    const storage = new AppStorage(tempPaths());
    const bus = new EventBus();
    const apps = { getManifest: (slug: string) => (slug === 'mirror' ? manifest : undefined) };
    return { store: new AppSettingsValuesStore(apps, storage, bus), storage, bus };
  }

  test('merges stored values over the manifest defaults', () => {
    const { store, storage } = setup();
    expect(store.get('mirror')).toEqual({ projection: { mode: 'direct', mirror: true } });
    storage.set('mirror', 'config', {
      projection: { mode: 'reflection' },
      sleep: { enabled: true },
    });
    expect(store.get('mirror')).toEqual({
      projection: { mode: 'reflection', mirror: true },
      sleep: { enabled: true },
    });
  });

  test('validates writes against the declared fields and keeps undeclared keys', () => {
    const { store, storage, bus } = setup();
    const events = recordEvents(bus);
    storage.set('mirror', 'config', { sleep: { enabled: true } });
    const values = store.set('mirror', { 'projection.mirror': false, zoom: 1.5 });
    expect(values).toEqual({
      projection: { mode: 'direct', mirror: false },
      zoom: 1.5,
      sleep: { enabled: true },
    });
    expect(events.at(-1)).toEqual({
      event: 'app:settings-changed',
      payload: { appSlug: 'mirror', values },
    });
    expect(store.set('mirror', { 'projection.mirror': null })).toMatchObject({
      projection: { mirror: true },
    });
    expect(storage.get('mirror', 'config')).toEqual({
      found: true,
      value: { sleep: { enabled: true }, projection: {}, zoom: 1.5 },
    });

    expect(() => store.set('mirror', { 'projection.mode': 'sideways' })).toThrow('one of');
    expect(() => store.set('mirror', { zoom: 9 })).toThrow('at most 2');
    expect(() => store.set('mirror', { 'projection.mirror': 'yes' })).toThrow('boolean');
    expect(() => store.set('mirror', { undeclared: 1 })).toThrow('declares no setting');
    expect(() => store.get('ghost')).toThrow('not installed');
  });
});

describe('legacy app data migration', () => {
  function legacyApp(
    paths: ReturnType<typeof tempPaths>,
    slug: string,
    withManifest: boolean,
  ): void {
    const appDir = join(paths.apps, slug);
    mkdirSync(join(appDir, '_data', 'storage'), { recursive: true });
    mkdirSync(join(appDir, '_config'), { recursive: true });
    writeFileSync(join(appDir, '_data', 'storage', 'score.json'), '3');
    writeFileSync(join(appDir, '_config', 'settings.json'), JSON.stringify({ display: { id: 1 } }));
    if (withManifest) writeFileSync(join(appDir, 'gosai.app.json'), '{}');
  }

  test('moves storage and device settings into the data directory once', () => {
    const paths = tempPaths();
    legacyApp(paths, 'installed', true);
    legacyApp(paths, 'builtin-leftover', false);
    const log = new Logger({ logsDir: paths.logs }).child('migration');

    expect(migrateLegacyAppData(paths, log)).toEqual({ moved: 4, conflicts: 0 });
    for (const slug of ['installed', 'builtin-leftover']) {
      expect(readFileSync(join(paths.data, slug, 'storage', 'score.json'), 'utf8')).toBe('3');
      expect(existsSync(join(paths.data, slug, 'device-settings.json'))).toBe(true);
      expect(existsSync(join(paths.apps, slug, '_data'))).toBe(false);
      expect(existsSync(join(paths.apps, slug, '_config'))).toBe(false);
    }
    // The checkout stays; a directory that only held data goes.
    expect(existsSync(join(paths.apps, 'installed', 'gosai.app.json'))).toBe(true);
    expect(existsSync(join(paths.apps, 'builtin-leftover'))).toBe(false);

    expect(migrateLegacyAppData(paths, log)).toEqual({ moved: 0, conflicts: 0 });
    const storage = new AppStorage(paths);
    expect(storage.get('installed', 'score')).toEqual({ found: true, value: 3 });
  });

  test('never overwrites data already in the data directory', () => {
    const paths = tempPaths();
    legacyApp(paths, 'pool', true);
    new AppStorage(paths).set('pool', 'score', 10);
    const logger = new Logger({ logsDir: paths.logs });

    expect(migrateLegacyAppData(paths, logger.child('migration'))).toEqual({
      moved: 1,
      conflicts: 1,
    });
    expect(new AppStorage(paths).get('pool', 'score')).toEqual({ found: true, value: 10 });
    expect(existsSync(join(paths.apps, 'pool', '_data', 'storage', 'score.json'))).toBe(true);
    expect(logger.history().some((entry) => entry.level === 'warn')).toBe(true);
  });
});
