import { parseCameraCapabilities, type CameraCapabilities } from './camera.js';
import { useServerResource, type ServerResourceView } from './use-server-resource.js';

/**
 * The modes and focus control of a camera device, probed through the camera driver's
 * `list_formats` action. Probes again on reconnect and on `reload()`.
 */
export function useCameraFormats(
  device: number | undefined,
): ServerResourceView<CameraCapabilities> {
  return useServerResource({
    command: 'driver:execute',
    payload: { driver: 'camera', action: 'list_formats', data: { device: device ?? 0 } },
    select: parseCameraCapabilities,
    enabled: device !== undefined,
  });
}
