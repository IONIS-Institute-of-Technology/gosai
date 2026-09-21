import type {
  AppDeviceSettings,
  CameraSettings,
  GlobalConfig,
  MicrophoneSettings,
} from '@gosai/shared';
import type { ChildLogger } from '../logger/logger.js';
import type { DriverService } from './hub.js';
import { SYSTEM_BINDING } from './manager.js';

/** Where device settings come from: the global config and per-app overrides. */
export interface DeviceSettingsSources {
  readonly config: { get(): GlobalConfig };
  readonly appSettings: { get(appSlug: string): AppDeviceSettings };
}

export type ResolvedCameraSettings = Required<CameraSettings>;

/**
 * The one place that decides a binding's camera settings. The per-app block
 * wins field by field, so an app that only pins a device still inherits the
 * global resolution, frame rate and rotation.
 */
export function resolveCameraSettings(
  global: CameraSettings,
  app: Partial<CameraSettings> | undefined,
): ResolvedCameraSettings {
  return {
    device: app?.device ?? global.device,
    width: app?.width ?? global.width,
    height: app?.height ?? global.height,
    fps: app?.fps ?? global.fps,
    rotation: app?.rotation ?? global.rotation ?? 0,
    // `null` is autofocus. An app without its own focus follows the global one.
    focus: app?.focus ?? global.focus ?? null,
  };
}

function appSettingsFor(sources: DeviceSettingsSources, binding: string): AppDeviceSettings {
  return binding === SYSTEM_BINDING ? {} : sources.appSettings.get(binding);
}

export function cameraSettingsFor(
  sources: DeviceSettingsSources,
  binding: string,
): ResolvedCameraSettings {
  return resolveCameraSettings(
    sources.config.get().camera,
    appSettingsFor(sources, binding).camera,
  );
}

/** Startup config for a driver instance, used by `DriverManagerOptions.getDriverConfig`. */
export function driverConfigFor(
  sources: DeviceSettingsSources,
  binding: string,
  driver: string,
): Record<string, unknown> | undefined {
  if (driver === 'camera') return { ...cameraSettingsFor(sources, binding) };
  const app = appSettingsFor(sources, binding);
  if (driver === 'microphone') return app.microphone ? { ...app.microphone } : undefined;
  if (driver === 'speaker') return app.speaker ? { ...app.speaker } : undefined;
  return undefined;
}

function sameCamera(a: ResolvedCameraSettings, b: ResolvedCameraSettings): boolean {
  return (
    a.device === b.device &&
    a.width === b.width &&
    a.height === b.height &&
    a.fps === b.fps &&
    a.rotation === b.rotation &&
    a.focus === b.focus
  );
}

/** Hot-apply resolved camera settings to a binding's running camera instance. */
export async function applyCameraSettings(
  drivers: DriverService,
  binding: string,
  settings: ResolvedCameraSettings,
  log: ChildLogger,
): Promise<void> {
  if (!drivers.isInstanceRunning(binding, 'camera')) return;
  try {
    await drivers.execute(binding, 'camera', 'set_mode', { ...settings });
  } catch (err) {
    log.warn('failed to apply camera settings to running driver', {
      binding,
      err: String(err),
      settings,
    });
  }
}

/**
 * Hot-apply a global camera change to every running camera whose resolved
 * settings changed. Call after the config store has been updated.
 */
export async function applyGlobalCameraSettings(
  drivers: DriverService,
  sources: DeviceSettingsSources,
  previousGlobal: CameraSettings,
  log: ChildLogger,
): Promise<void> {
  for (const binding of drivers.runningBindings('camera')) {
    const app = appSettingsFor(sources, binding).camera;
    const next = cameraSettingsFor(sources, binding);
    if (sameCamera(resolveCameraSettings(previousGlobal, app), next)) continue;
    await applyCameraSettings(drivers, binding, next, log);
  }
}

/**
 * Hot-apply a binding's per-app device settings to its running driver
 * instances. Call after the app settings store has been updated. Camera and
 * microphone are exclusive per app, so their settings can be applied live; the
 * speaker is shared, so device changes there take effect on the next start
 * rather than disrupting other apps.
 */
export async function applyAppDeviceSettings(
  drivers: DriverService,
  sources: DeviceSettingsSources,
  binding: string,
  previous: AppDeviceSettings,
  log: ChildLogger,
): Promise<void> {
  const next = appSettingsFor(sources, binding);
  const global = sources.config.get().camera;
  const camera = resolveCameraSettings(global, next.camera);
  if (!sameCamera(resolveCameraSettings(global, previous.camera), camera)) {
    await applyCameraSettings(drivers, binding, camera, log);
  }

  if (drivers.isInstanceRunning(binding, 'microphone')) {
    try {
      await applyMicrophoneSettings(
        drivers,
        binding,
        next.microphone ?? {},
        previous.microphone ?? {},
      );
    } catch (err) {
      log.warn('failed to apply microphone settings to running driver', {
        binding,
        err: String(err),
      });
    }
  }
}

async function applyMicrophoneSettings(
  drivers: DriverService,
  binding: string,
  next: Partial<MicrophoneSettings>,
  previous: Partial<MicrophoneSettings>,
): Promise<void> {
  // No device override means the system default.
  const device = next.device ?? null;
  if (device !== (previous.device ?? null)) {
    await drivers.execute(binding, 'microphone', 'set_device', device);
  }
  if (next.samplerate != null && next.samplerate !== previous.samplerate) {
    await drivers.execute(binding, 'microphone', 'set_samplerate', next.samplerate);
  }
}
