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
  return {
    load: async () => ({ ...(await server.request('app:settings:get', { appSlug })) }),
    update: async (values) => {
      await server.request('app:settings:set', { appSlug, values: settingValues(values) });
    },
    subscribe: (listener) =>
      server.on('app:settings-changed', (change) => {
        if (change.appSlug === appSlug) listener({ ...change.values });
      }),
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
