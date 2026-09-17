import type { CameraFormat } from '@gosai/shared';
import { parseCameraFormats } from './camera.js';
import { useServerResource, type ServerResourceView } from './use-server-resource.js';

/**
 * The modes a camera device supports, probed through the camera driver's
 * `list_formats` action. Probes again on reconnect and on `reload()`.
 */
export function useCameraFormats(
  device: number | undefined,
): ServerResourceView<readonly CameraFormat[]> {
  return useServerResource({
    command: 'driver:execute',
    payload: { driver: 'camera', action: 'list_formats', data: { device: device ?? 0 } },
    select: parseCameraFormats,
    enabled: device !== undefined,
  });
}
