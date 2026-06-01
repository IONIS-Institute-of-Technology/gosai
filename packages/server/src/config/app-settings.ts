/**
 * Per-application device settings. Each app gets its own
 * `<paths.apps>/<slug>/_config/settings.json` mapping the device kinds it
 * declares in its manifest `requirements` to concrete devices (camera index,
 * microphone/speaker device, display id + mode).
 *
 * Camera and microphone are exclusive (each app binds its own physical device);
 * speaker and display may be shared across apps.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  AppDeviceSettings,
  AppDeviceSettingsPatch,
  AppDisplaySettings,
  CameraSettings,
  MicrophoneSettings,
  SpeakerSettings,
} from '@gosai/shared';
import { ServerEvents } from '@gosai/shared/events';
import type { EventBus } from '../ipc/index.js';
import type { ChildLogger } from '../logger/index.js';

const SETTINGS_FILE = 'settings.json';

export class AppSettingsStore {
  private readonly cache = new Map<string, AppDeviceSettings>();

  constructor(
    private readonly appsDir: string,
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

  update(appSlug: string, patch: AppDeviceSettingsPatch): AppDeviceSettings {
    const current = this.get(appSlug);
    const next: AppDeviceSettings = {
      ...current,
      ...(patch.display !== undefined
        ? { display: mergeDisplay(current.display, patch.display) }
        : {}),
      ...(patch.camera !== undefined
        ? { camera: { ...current.camera, ...patch.camera } as CameraSettings }
        : {}),
      ...(patch.microphone !== undefined
        ? { microphone: { ...current.microphone, ...patch.microphone } as MicrophoneSettings }
        : {}),
      ...(patch.speaker !== undefined
        ? { speaker: { ...current.speaker, ...patch.speaker } as SpeakerSettings }
        : {}),
    };
    this.cache.set(appSlug, next);
    this.persist(appSlug, next);
    this.bus.emit(ServerEvents.AppConfigChanged, { appSlug, settings: next }, 'app-config');
    return next;
  }

  private settingsPath(appSlug: string): string {
    return join(this.appsDir, appSlug, '_config', SETTINGS_FILE);
  }

  private load(appSlug: string): AppDeviceSettings {
    const path = this.settingsPath(appSlug);
    if (!existsSync(path)) return {};
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as AppDeviceSettings;
    } catch (err) {
      this.log.warn('app settings file is corrupt, falling back to empty', {
        app: appSlug,
        err: String(err),
      });
      return {};
    }
  }

  private persist(appSlug: string, settings: AppDeviceSettings): void {
    const path = this.settingsPath(appSlug);
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(settings, null, 2), 'utf8');
    } catch (err) {
      this.log.error('failed to persist app settings', { app: appSlug, err: String(err) });
    }
  }
}

function mergeDisplay(
  current: AppDisplaySettings | undefined,
  patch: Partial<AppDisplaySettings>,
): AppDisplaySettings {
  return {
    id: patch.id !== undefined ? patch.id : (current?.id ?? null),
    mode: patch.mode ?? current?.mode ?? 'fullscreen',
  };
}
