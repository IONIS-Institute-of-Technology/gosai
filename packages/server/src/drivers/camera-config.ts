import type { AppDeviceSettings, CameraSettings } from '@gosai/shared';
import type { ChildLogger } from '../logger/index.js';
import type { DriverManager } from './manager.js';

/** Hot-apply camera settings to a binding's running camera instance. */
export async function applyCameraSettings(
  drivers: DriverManager,
  binding: string,
  settings: CameraSettings,
  log: ChildLogger,
): Promise<void> {
  if (!drivers.isInstanceRunning(binding, 'camera')) return;

  try {
    await drivers.execute(binding, 'camera', 'set_mode', {
      device: settings.device,
      width: settings.width,
      height: settings.height,
      fps: settings.fps,
      rotation: settings.rotation ?? 0,
    });
  } catch (err) {
    log.warn('failed to apply camera settings to running driver', {
      binding,
      err: String(err),
      settings,
    });
  }
}

/**
 * Hot-apply a binding's persisted per-app device settings to its running
 * driver instances. Camera and microphone are exclusive per app, so their
 * settings can be applied live; the speaker is shared, so device changes there
 * take effect on the next start rather than disrupting other apps.
 */
export async function applyAppDeviceSettings(
  drivers: DriverManager,
  binding: string,
  settings: AppDeviceSettings,
  log: ChildLogger,
): Promise<void> {
  if (settings.camera) {
    await applyCameraSettings(drivers, binding, settings.camera, log);
  }

  if (settings.microphone && drivers.isInstanceRunning(binding, 'microphone')) {
    try {
      await drivers.execute(binding, 'microphone', 'set_device', settings.microphone.device);
      if (settings.microphone.samplerate != null) {
        await drivers.execute(
          binding,
          'microphone',
          'set_samplerate',
          settings.microphone.samplerate,
        );
      }
    } catch (err) {
      log.warn('failed to apply microphone settings to running driver', {
        binding,
        err: String(err),
      });
    }
  }
}
