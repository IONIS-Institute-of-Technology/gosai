/**
 * App settings declared by the manifest `settings` schema. The dashboard
 * stores the values as one nested object under the schema's storage key.
 */

import type { AppSettingsSchema } from '@gosai/shared';
import type { SettingsClient, StorageClient } from './types.js';

type SettingsObject = Record<string, unknown>;

/**
 * Where settings come from. Today the SDK merges stored values over the
 * manifest defaults itself; a server command that returns the merged
 * settings can implement this interface instead.
 */
export interface SettingsBackend {
  /** Current settings with the manifest defaults applied. */
  load(): Promise<SettingsObject>;
  /** Stores values by dotted key on top of what is already stored. */
  update(values: Readonly<Record<string, unknown>>): Promise<void>;
}

export const DEFAULT_SETTINGS_STORAGE_KEY = 'config';

export function createSettingsClient(backend: SettingsBackend): SettingsClient {
  return {
    get: async <T extends object>() => (await backend.load()) as T,
    set: (values) => backend.update(values),
  };
}

/** Settings backed by app storage and the schema's defaults. */
export function storageSettingsBackend(
  schema: AppSettingsSchema | undefined,
  storage: StorageClient,
): SettingsBackend {
  const key = schema?.storageKey ?? DEFAULT_SETTINGS_STORAGE_KEY;
  const readStored = async (): Promise<SettingsObject> => {
    const stored = await storage.get<unknown>(key);
    return isPlainObject(stored) ? stored : {};
  };
  return {
    load: async () => mergeSettings(settingsDefaults(schema), await readStored()),
    update: async (values) => {
      let next = await readStored();
      for (const [path, value] of Object.entries(values)) next = setPath(next, path, value);
      await storage.set(key, next);
    },
  };
}

/** The schema's field defaults as a nested object. */
export function settingsDefaults(schema: AppSettingsSchema | undefined): SettingsObject {
  let defaults: SettingsObject = {};
  for (const group of schema?.groups ?? []) {
    for (const field of group.fields) {
      if (field.default !== undefined) defaults = setPath(defaults, field.key, field.default);
    }
  }
  return defaults;
}

/**
 * Deep-merges `stored` over `defaults` into a new object. Nested objects
 * merge key by key; any other stored value replaces the default.
 */
export function mergeSettings(defaults: SettingsObject, stored: SettingsObject): SettingsObject {
  const out: SettingsObject = { ...defaults };
  for (const [key, value] of Object.entries(stored)) {
    const base = out[key];
    out[key] = isPlainObject(base) && isPlainObject(value) ? mergeSettings(base, value) : value;
  }
  return out;
}

/** Returns a copy of `target` with `value` written at a dotted `path`. */
function setPath(target: SettingsObject, path: string, value: unknown): SettingsObject {
  const [head, ...rest] = path.split('.');
  if (head === undefined || head === '') return target;
  if (rest.length === 0) return { ...target, [head]: value };
  const child = target[head];
  return { ...target, [head]: setPath(isPlainObject(child) ? child : {}, rest.join('.'), value) };
}

function isPlainObject(value: unknown): value is SettingsObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
