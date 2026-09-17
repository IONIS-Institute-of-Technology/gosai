/**
 * Values of the settings an app declares in its manifest. They are stored as
 * one nested object under the schema's storage key; reads merge them over the
 * declared defaults, and writes check each value against its field.
 */

import type {
  AppSettingValue,
  AppSettingsField,
  AppSettingsSchema,
  AppSettingsValues,
} from '@gosai/shared';
import {
  deleteSettingValue,
  mergeSettings,
  setSettingValue,
  settingsDefaults,
  settingsStorageKey,
} from '@gosai/shared/app-settings';
import { ServerEvents } from '@gosai/shared/events';
import type { EventBus } from '../ipc/bus.js';
import type { AppStorage } from './storage.js';
import type { AppManager } from './manager.js';

export class AppSettingsValuesStore {
  constructor(
    private readonly apps: Pick<AppManager, 'getManifest'>,
    private readonly storage: AppStorage,
    private readonly bus: EventBus,
  ) {}

  /** Stored values merged over the defaults. `{}` for an app without a settings schema. */
  get(appSlug: string): AppSettingsValues {
    const schema = this.schemaOf(appSlug);
    if (!schema) return {};
    return mergeSettings(settingsDefaults(schema), this.stored(appSlug, schema));
  }

  /**
   * Writes values by declared field key. `null` removes the stored value so
   * the default applies again. Stored keys the schema doesn't declare are kept.
   */
  set(
    appSlug: string,
    values: Readonly<Record<string, AppSettingValue | null>>,
    origin?: string,
  ): AppSettingsValues {
    const schema = this.schemaOf(appSlug);
    if (!schema) throw new Error(`App ${appSlug} declares no settings`);
    const fields = new Map(
      schema.groups.flatMap((group) => group.fields).map((field) => [field.key, field]),
    );
    let next = this.stored(appSlug, schema);
    for (const [key, value] of Object.entries(values)) {
      const field = fields.get(key);
      if (!field) throw new Error(`${appSlug} declares no setting ${key}`);
      if (value === null) {
        next = deleteSettingValue(next, key);
        continue;
      }
      const problem = invalidValue(field, value);
      if (problem) throw new Error(`${key}: ${problem}`);
      next = setSettingValue(next, key, value);
    }
    this.storage.set(appSlug, settingsStorageKey(schema), next);
    const merged = mergeSettings(settingsDefaults(schema), next);
    this.bus.emit(
      ServerEvents.AppSettingsChanged,
      { appSlug, values: merged },
      'app-settings',
      origin,
    );
    return merged;
  }

  private schemaOf(appSlug: string): AppSettingsSchema | undefined {
    const manifest = this.apps.getManifest(appSlug);
    if (!manifest) throw new Error(`App not installed: ${appSlug}`);
    return manifest.settings;
  }

  private stored(appSlug: string, schema: AppSettingsSchema): AppSettingsValues {
    const stored = this.storage.get(appSlug, settingsStorageKey(schema));
    if (!stored.found) return {};
    const value = stored.value;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(`Stored settings of ${appSlug} are not an object`);
    }
    return value as AppSettingsValues;
  }
}

function invalidValue(field: AppSettingsField, value: AppSettingValue): string | null {
  switch (field.type) {
    case 'boolean':
      return typeof value === 'boolean' ? null : 'must be a boolean';
    case 'string':
      return typeof value === 'string' ? null : 'must be a string';
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'must be a number';
      if (field.min !== undefined && value < field.min) return `must be at least ${field.min}`;
      if (field.max !== undefined && value > field.max) return `must be at most ${field.max}`;
      return null;
    case 'select':
      return (field.options ?? []).some((option) => option.value === value)
        ? null
        : `must be one of ${(field.options ?? []).map((o) => o.value).join(', ')}`;
  }
}
