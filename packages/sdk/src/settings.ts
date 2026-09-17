/**
 * App settings declared by the manifest `settings` schema. The server stores
 * them as one nested object and answers `app:settings:get` with the stored
 * values merged over the manifest defaults.
 */

import type { AppSettingValue } from '@gosai/shared';
import type { ServerConnection, SettingsClient } from './types.js';

type SettingsObject = Record<string, unknown>;

/** Where settings come from. The runtime uses the server's `app:settings:*` commands. */
export interface SettingsBackend {
  /** Current settings with the manifest defaults applied. */
  load(): Promise<SettingsObject>;
  /** Stores values by dotted key on top of what is already stored. */
  update(values: Readonly<Record<string, unknown>>): Promise<void>;
  /**
   * Calls `listener` with the current settings each time they change. Returns
   * a function that removes it. Without it, `onChange` listeners never fire.
   */
  subscribe?(listener: (settings: SettingsObject) => void): () => void;
}

export function createSettingsClient(backend: SettingsBackend): SettingsClient {
  return {
    get: async <T extends object>() => (await backend.load()) as T,
    set: (values) => backend.update(values),
    onChange: <T extends object>(listener: (settings: T) => void) =>
      backend.subscribe?.((settings) => listener(settings as T)) ?? ((): void => undefined),
  };
}

/**
 * Settings backed by the server, which merges the manifest defaults in and
 * checks each value against its declared field.
 */
export function serverSettingsBackend(appSlug: string, server: ServerConnection): SettingsBackend {
  const load = async (): Promise<SettingsObject> => ({
    ...(await server.request('app:settings:get', { appSlug })),
  });
  const listeners = new Set<(settings: SettingsObject) => void>();
  /** JSON of the settings listeners last saw, or `null` before the first known value. */
  let last: string | null = null;
  /** Bumped on every change, so a slower load can't replace newer settings. */
  let version = 0;
  let release: (() => void) | null = null;

  /** Notifies listeners unless the settings equal the ones they last saw. */
  const publish = (settings: SettingsObject): void => {
    const json = JSON.stringify(settings);
    version += 1;
    if (json === last) return;
    last = json;
    for (const listener of listeners) listener({ ...settings });
  };

  /**
   * Loads the settings. `announce` publishes them; otherwise they only become
   * the last seen settings, when none are known yet.
   */
  const refresh = (announce: boolean): void => {
    const started = version;
    load().then(
      (settings) => {
        if (version !== started) return;
        if (announce) publish(settings);
        else last ??= JSON.stringify(settings);
      },
      () => undefined,
    );
  };

  const start = (): (() => void) => {
    // Changes broadcast while disconnected are lost, so a reconnect reloads.
    const offChange = server.on('app:settings-changed', (change) => {
      if (change.appSlug === appSlug) publish({ ...change.values });
    });
    const offStatus = server.onStatus((status) => {
      if (status === 'connected') refresh(true);
    });
    refresh(false);
    return () => {
      offChange();
      offStatus();
      last = null;
      version += 1;
    };
  };

  return {
    load,
    update: async (values) => {
      await server.request('app:settings:set', { appSlug, values: settingValues(values) });
    },
    subscribe: (listener) => {
      listeners.add(listener);
      release ??= start();
      return () => {
        if (!listeners.delete(listener) || listeners.size > 0) return;
        release?.();
        release = null;
      };
    },
  };
}

/** Checks the values are ones a setting can hold; `null` restores a default. */
function settingValues(
  values: Readonly<Record<string, unknown>>,
): Record<string, AppSettingValue | null> {
  const out: Record<string, AppSettingValue | null> = {};
  for (const [key, value] of Object.entries(values)) {
    if (
      value !== null &&
      typeof value !== 'string' &&
      typeof value !== 'number' &&
      typeof value !== 'boolean'
    ) {
      throw new TypeError(`setting ${key} must be a string, number, boolean or null`);
    }
    out[key] = value;
  }
  return out;
}
