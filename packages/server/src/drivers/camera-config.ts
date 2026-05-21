import type { CameraSettings } from '@gosai/shared';
import type { ChildLogger } from '../logger/index.js';
import type { DriverManager } from './manager.js';

export async function applyCameraSettings(
  drivers: DriverManager,
  settings: CameraSettings,
  log: ChildLogger,
): Promise<void> {
  const info = drivers.getDriver('camera');
  if (!info || info.state !== 'running') return;

  try {
    await drivers.execute('camera', 'set_device', settings.device);
    await drivers.execute('camera', 'set_resolution', {
      width: settings.width,
      height: settings.height,
    });
    await drivers.execute('camera', 'set_fps', settings.fps);
  } catch (err) {
    log.warn('failed to apply camera settings to running driver', {
      err: String(err),
      settings,
    });
  }
}
