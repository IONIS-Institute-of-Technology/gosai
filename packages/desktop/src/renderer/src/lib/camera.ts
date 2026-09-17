/** Camera mode helpers shared by the global and per-app camera pickers. */

import type { AppDeviceSettingsPatch, CameraFormat, CameraSettings } from '@gosai/shared';

export type CameraModePatch = Partial<Pick<CameraSettings, 'width' | 'height' | 'fps'>>;

export function formatKey(width: number, height: number): string {
  return `${width}x${height}`;
}

export function formatCameraMode(format: CameraFormat): string {
  const codecs = format.codecs?.length ? ` · ${format.codecs.join('/')}` : '';
  return `${format.width}×${format.height}${codecs}`;
}

/** Keeps the current rate when the format has it, else 30 fps, else the fastest rate up to 30. */
export function choosePreferredFps(
  format: CameraFormat,
  current?: number | null,
): number | undefined {
  if (current != null && format.fps.includes(current)) return current;
  if (format.fps.includes(30)) return 30;
  const atMost30 = [...format.fps].filter((f) => f <= 30).sort((a, b) => b - a)[0];
  return atMost30 ?? [...format.fps].sort((a, b) => b - a)[0];
}

export function findFormat(
  formats: readonly CameraFormat[] | undefined,
  width: number | null,
  height: number | null,
): CameraFormat | undefined {
  if (width == null || height == null) return undefined;
  return formats?.find((f) => f.width === width && f.height === height);
}

/** The patch for a resolution picked by its {@link formatKey}, or `null` for an unknown key. */
export function resolutionPatch(
  formats: readonly CameraFormat[] | undefined,
  key: string,
  currentFps: number | null,
): CameraModePatch | null {
  const format = formats?.find((f) => formatKey(f.width, f.height) === key);
  if (!format) return null;
  const fps = choosePreferredFps(format, currentFps);
  return { width: format.width, height: format.height, ...(fps !== undefined ? { fps } : {}) };
}

/** Reads the camera driver's `list_formats` result. Throws when it lists no mode. */
export function parseCameraFormats(result: unknown): readonly CameraFormat[] {
  const value = (result ?? {}) as { formats?: unknown; error?: unknown };
  if (!Array.isArray(value.formats) || value.formats.length === 0) {
    throw new Error(
      typeof value.error === 'string' && value.error
        ? value.error
        : 'No supported camera modes detected',
    );
  }
  return value.formats as readonly CameraFormat[];
}

/** The per-app patch for a camera picked in a device select. `null` clears the override. */
export function cameraDevicePatch(device: number | null): AppDeviceSettingsPatch {
  return { camera: { device } };
}
