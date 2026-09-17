/**
 * Per-app device settings, stored at `paths.data/<slug>/device-settings.json`.
 * They map the device kinds an app declares in its manifest `requirements` to
 * concrete devices (camera index and mode, microphone and speaker device,
 * display id and mode). Every field is an override; a missing one inherits
 * the global setting or the system default.
 *
 * Camera and microphone are exclusive (each app binds its own physical device);
 * speaker and display may be shared across apps.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppDeviceSettings, AppDeviceSettingsPatch } from '@gosai/shared';
import { ServerEvents } from '@gosai/shared/events';
import { appDeviceSettingsSchema, formatZodError } from '@gosai/shared/schemas';
import type { EventBus } from '../ipc/bus.js';
import type { ChildLogger } from '../logger/logger.js';
import { appDataDir, type GosaiPaths } from '../paths.js';
import { writeJsonAtomic } from './config.js';

export const DEVICE_SETTINGS_FILE = 'device-settings.json';

type Block = Record<string, unknown>;

export class AppSettingsStore {
  private readonly cache = new Map<string, AppDeviceSettings>();

  constructor(
    private readonly paths: Pick<GosaiPaths, 'data'>,
    private readonly bus: EventBus,
    private readonly log: ChildLogger,
  ) {}

  get(appSlug: string): AppDeviceSettings {
    const cached = this.cache.get(appSlug);
    if (cached) return cached;
    const loaded = this.load(appSlug);
    this.cache.set(appSlug, loaded);
    return loaded;
  }

  /**
   * Merges each block of `patch` over the stored block. `null` for a block or
   * a field removes that override.
   */
  update(appSlug: string, patch: AppDeviceSettingsPatch): AppDeviceSettings {
    const next: Record<string, Block> = { ...(this.get(appSlug) as Record<string, Block>) };
    for (const [kind, blockPatch] of Object.entries(patch)) {
      if (blockPatch === undefined) continue;
      const merged = blockPatch === null ? {} : mergeBlock(next[kind] ?? {}, blockPatch);
      if (Object.keys(merged).length === 0) delete next[kind];
      else next[kind] = merged;
    }
    const settings = next as AppDeviceSettings;
    this.cache.set(appSlug, settings);
    this.persist(appSlug, settings);
    this.bus.emit(ServerEvents.AppConfigChanged, { appSlug, settings }, 'app-config');
    return settings;
  }

  private settingsPath(appSlug: string): string {
    return join(appDataDir(this.paths, appSlug), DEVICE_SETTINGS_FILE);
  }

  private load(appSlug: string): AppDeviceSettings {
    const path = this.settingsPath(appSlug);
    if (!existsSync(path)) return {};
    try {
      const parsed = appDeviceSettingsSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
      if (parsed.success) return parsed.data;
      this.log.warn('app device settings are invalid, ignoring them', {
        app: appSlug,
        problem: formatZodError(parsed.error),
      });
    } catch (err) {
      this.log.warn('app device settings are not valid JSON, ignoring them', {
        app: appSlug,
        err: String(err),
      });
    }
    return {};
  }

  private persist(appSlug: string, settings: AppDeviceSettings): void {
    try {
      mkdirSync(appDataDir(this.paths, appSlug), { recursive: true });
      writeJsonAtomic(this.settingsPath(appSlug), settings);
    } catch (err) {
      this.log.error('failed to persist app settings', { app: appSlug, err: String(err) });
    }
  }
}

function mergeBlock(current: Block, patch: Readonly<Record<string, unknown>>): Block {
  const next: Block = { ...current };
  for (const [field, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null) delete next[field];
    else next[field] = value;
  }
  return next;
}
