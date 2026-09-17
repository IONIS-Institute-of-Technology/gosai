import { describe, expect, test } from 'bun:test';
import {
  mergeSettings,
  settingsDefaults,
  storageSettingsBackend,
  createSettingsClient,
} from '../src/settings.js';
import type { StorageClient } from '../src/types.js';
import { MANIFEST } from './fakes.js';

function memoryStorage(initial: Record<string, unknown> = {}): StorageClient & {
  data: Record<string, unknown>;
} {
  const data = { ...initial };
  return {
    data,
    get: (async (key: string, fallback?: unknown) =>
      key in data ? structuredClone(data[key]) : fallback) as StorageClient['get'],
    set: async (key, value) => void (data[key] = structuredClone(value)),
    remove: async (key) => void delete data[key],
    list: async () => Object.keys(data),
  };
}

describe('settings', () => {
  test('defaults nest dotted keys', () => {
    expect(settingsDefaults(MANIFEST.settings)).toEqual({
      display: { mode: 'contain', zoom: 1 },
      debug: false,
    });
    expect(settingsDefaults(undefined)).toEqual({});
  });

  test('stored values merge over defaults without mutating them', () => {
    const defaults = settingsDefaults(MANIFEST.settings);
    const merged = mergeSettings(defaults, { display: { zoom: 2 }, extra: [1, 2] });
    expect(merged).toEqual({ display: { mode: 'contain', zoom: 2 }, debug: false, extra: [1, 2] });
    expect(defaults).toEqual({ display: { mode: 'contain', zoom: 1 }, debug: false });
  });

  test('get returns merged settings and set stores only the given keys', async () => {
    const storage = memoryStorage({ config: { display: { mode: 'cover' } } });
    const settings = createSettingsClient(storageSettingsBackend(MANIFEST.settings, storage));
    expect(await settings.get()).toEqual({ display: { mode: 'cover', zoom: 1 }, debug: false });

    await settings.set({ 'display.zoom': 1.5, debug: true });
    expect(storage.data.config).toEqual({ display: { mode: 'cover', zoom: 1.5 }, debug: true });

    const first = await settings.get<{ display: { zoom: number } }>();
    first.display.zoom = 99;
    expect((await settings.get<{ display: { zoom: number } }>()).display.zoom).toBe(1.5);
  });

  test('ignores a stored value that is not an object', async () => {
    const storage = memoryStorage({ config: 'garbage' });
    const settings = createSettingsClient(storageSettingsBackend(MANIFEST.settings, storage));
    expect(await settings.get()).toEqual(settingsDefaults(MANIFEST.settings));
    await settings.set({ debug: true });
    expect(storage.data.config).toEqual({ debug: true });
  });

  test('uses the schema storage key, defaulting to config', async () => {
    const storage = memoryStorage({ prefs: { debug: true } });
    const custom = createSettingsClient(
      storageSettingsBackend({ storageKey: 'prefs', groups: [] }, storage),
    );
    expect(await custom.get()).toEqual({ debug: true });
    const fallback = createSettingsClient(storageSettingsBackend(undefined, storage));
    await fallback.set({ a: 1 });
    expect(storage.data.config).toEqual({ a: 1 });
  });
});
