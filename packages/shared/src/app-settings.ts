/**
 * Helpers for the declarative app settings in a manifest. Settings are stored
 * as one nested JSON object under the schema's storage key; field keys are
 * dotted paths into it.
 */

import type { AppSettingsSchema, AppSettingsValues } from './types.js';

export const DEFAULT_SETTINGS_STORAGE_KEY = 'config';

/** Dotted path of identifier-like segments, e.g. `projection.mode`. */
export const SETTING_KEY_PATTERN = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/;

/** Segments that would reach `Object.prototype` when used as property names. */
const FORBIDDEN_SEGMENTS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

type MutableValues = Record<string, unknown>;

export function isValidSettingKey(key: string): boolean {
  return (
    SETTING_KEY_PATTERN.test(key) && key.split('.').every((part) => !FORBIDDEN_SEGMENTS.has(part))
  );
}

export function settingsStorageKey(schema: AppSettingsSchema): string {
  return schema.storageKey ?? DEFAULT_SETTINGS_STORAGE_KEY;
}

function isPlainObject(value: unknown): value is MutableValues {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function getSettingValue(values: AppSettingsValues, key: string): unknown {
  let current: unknown = values;
  for (const part of key.split('.')) {
    if (!isPlainObject(current) || !Object.hasOwn(current, part)) return undefined;
    current = current[part];
  }
  return current;
}

/** Returns a copy of `values` with `key` set, cloning the objects on the path. */
export function setSettingValue(
  values: AppSettingsValues,
  key: string,
  value: unknown,
): AppSettingsValues {
  const parts = key.split('.');
  const root: MutableValues = { ...values };
  let current = root;
  for (const part of parts.slice(0, -1)) {
    const existing = current[part];
    const next: MutableValues = isPlainObject(existing) ? { ...existing } : {};
    current[part] = next;
    current = next;
  }
  const last = parts[parts.length - 1];
  if (last !== undefined) current[last] = value;
  return root;
}

/** Returns a copy of `values` without `key`. Parents left empty are kept. */
export function deleteSettingValue(values: AppSettingsValues, key: string): AppSettingsValues {
  if (getSettingValue(values, key) === undefined) return values;
  const parts = key.split('.');
  const root: MutableValues = { ...values };
  let current = root;
  for (const part of parts.slice(0, -1)) {
    const next = { ...(current[part] as MutableValues) };
    current[part] = next;
    current = next;
  }
  const last = parts[parts.length - 1];
  if (last !== undefined) delete current[last];
  return root;
}

/** The declared defaults as a nested object. */
export function settingsDefaults(schema: AppSettingsSchema): AppSettingsValues {
  let values: AppSettingsValues = {};
  for (const group of schema.groups) {
    for (const field of group.fields) {
      if (field.default !== undefined) values = setSettingValue(values, field.key, field.default);
    }
  }
  return values;
}

/** Deep-merges `stored` over `defaults`. Arrays and other values replace. */
export function mergeSettings(
  defaults: AppSettingsValues,
  stored: AppSettingsValues,
): AppSettingsValues {
  const out: MutableValues = { ...defaults };
  for (const [key, value] of Object.entries(stored)) {
    if (FORBIDDEN_SEGMENTS.has(key)) continue;
    const base = out[key];
    out[key] = isPlainObject(base) && isPlainObject(value) ? mergeSettings(base, value) : value;
  }
  return out;
}
