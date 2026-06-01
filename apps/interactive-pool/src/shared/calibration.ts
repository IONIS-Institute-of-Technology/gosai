/**
 * Calibration data loader + driver configuration helpers.
 *
 * Reads the homography + focus quad persisted by the `calibration` app and
 * pushes the relevant pieces into the tracking drivers (`ball`, `hand_pose`)
 * so their emitted coordinates already live in the apps' 1920x1080 reference
 * space. Also exposes the focus quad in projector (display) coordinates so
 * the compositor can warp the canvas to land on the physical surface
 * exactly.
 *
 * Cross-app storage access works the same way `SystemHeader.tsx` does it:
 * a direct HTTP GET to the local server's REST endpoint. Returning `null` (or
 * a partial snapshot) is fine -- the compositor will simply skip keystone
 * correction and the tracking drivers will fall back to their legacy
 * uncorrected behaviour.
 */

import type { ExperienceRuntimeContext, Point2D } from '@gosai/sdk';

/** Local server hosting the GOSAI REST API. Matches the value used by every
 * other piece of the desktop app (AppHost, SystemHeader). */
const SERVER_BASE_URL = 'http://127.0.0.1:7777';
const CALIBRATION_APP_SLUG = 'calibration';

export interface SizeXY {
  readonly width: number;
  readonly height: number;
}

export interface CalibrationData {
  /** Camera -> projector display homography (9 floats, row-major). */
  readonly homography: readonly number[] | null;
  /** Camera -> surface reference space homography (9 floats, row-major). */
  readonly homographySurface: readonly number[] | null;
  /** Physical surface corners in display pixels (TL, TR, BR, BL). Drives the
   * CSS matrix3d keystone correction on the compositor canvas. */
  readonly surfaceQuadDisplay: readonly Point2D[] | null;
  /** Reference resolution that landmarks/balls are normalised to. */
  readonly surfaceSize: SizeXY | null;
  /** Camera resolution that was active when the homography was computed. */
  readonly frameSize: SizeXY | null;
}

function calibrationUrl(key: string): string {
  return `${SERVER_BASE_URL}/v1/apps/${CALIBRATION_APP_SLUG}/storage/${encodeURIComponent(key)}`;
}

/**
 * Fetch a single calibration storage value, returning `null` on 404. Prefers
 * this app's own per-app profile (`<key>__<appSlug>`) and falls back to the
 * legacy global key so existing single-app calibrations keep working.
 */
async function fetchCalibrationKey<T>(key: string, appSlug: string): Promise<T | null> {
  const scoped = await fetch(calibrationUrl(`${key}__${appSlug}`));
  if (scoped.status === 200) return (await scoped.json()) as T;
  if (scoped.status !== 404) {
    throw new Error(`calibration storage[${key}__${appSlug}] -> ${scoped.status}`);
  }
  const res = await fetch(calibrationUrl(key));
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`calibration storage[${key}] -> ${res.status}`);
  return (await res.json()) as T;
}

/** Load every calibration key in parallel. Each failed fetch is reported via
 * the runtime logger but never blocks the overall load. */
export async function loadCalibration(
  rt: ExperienceRuntimeContext,
): Promise<CalibrationData> {
  const appSlug = rt.app.appSlug;
  const safe = async <T>(key: string): Promise<T | null> => {
    try {
      return await fetchCalibrationKey<T>(key, appSlug);
    } catch (err) {
      rt.log.warn(`calibration[${key}] fetch failed`, { err: String(err) });
      return null;
    }
  };

  const [
    homography,
    homographySurface,
    surfaceQuadRaw,
    surfaceSize,
    frameSize,
  ] = await Promise.all([
    safe<number[]>('homography'),
    safe<number[]>('homography_surface'),
    safe<{ points: Point2D[] }>('surface_quad_display'),
    safe<SizeXY>('surface_size'),
    safe<SizeXY>('frame_size'),
  ]);

  const surfaceQuadDisplay =
    surfaceQuadRaw?.points && surfaceQuadRaw.points.length === 4
      ? surfaceQuadRaw.points
      : null;

  return {
    homography,
    homographySurface,
    surfaceQuadDisplay,
    surfaceSize,
    frameSize,
  };
}

/**
 * Configure the `ball` driver from the loaded calibration:
 *
 *   - `set_homography`: camera -> surface reference space so YOLO detections
 *     are warped into our 1920×1080 reference space (falls back to the legacy
 *     camera -> display matrix when surface is unavailable)
 *   - `set_output_size`: target reference resolution so the warped coordinates
 *     and radius scaling match our render space
 */
export async function configureBallDriver(
  rt: ExperienceRuntimeContext,
  cal: CalibrationData,
  fallbackSize: SizeXY,
): Promise<void> {
  const homography = cal.homographySurface ?? cal.homography;
  if (!homography) {
    rt.log.warn('ball driver not configured: no homography available');
    return;
  }
  const outputSize = cal.homographySurface
    ? (cal.surfaceSize ?? fallbackSize)
    : fallbackSize;

  await rt.drivers
    .execute('ball', 'set_homography', homography)
    .catch((err) => rt.log.warn('ball.set_homography failed', { err: String(err) }));
  await rt.drivers
    .execute('ball', 'set_output_size', {
      width: outputSize.width,
      height: outputSize.height,
    })
    .catch((err) => rt.log.warn('ball.set_output_size failed', { err: String(err) }));
}

/**
 * Configure the `hand_pose` driver from the loaded calibration. With the
 * camera -> surface homography in place, MediaPipe landmarks are warped
 * server-side so the values reaching this app are already normalised over
 * the apps' reference space.
 */
export async function configureHandPoseDriver(
  rt: ExperienceRuntimeContext,
  cal: CalibrationData,
  fallbackSize: SizeXY,
): Promise<void> {
  if (!cal.homographySurface) {
    // Without a surface homography the driver keeps emitting raw
    // camera-normalised coords (legacy behaviour). Nothing to configure.
    return;
  }
  if (!cal.frameSize) {
    rt.log.warn('hand_pose not configured: missing frame_size in calibration');
    return;
  }
  const surfaceSize = cal.surfaceSize ?? fallbackSize;
  await rt.drivers
    .execute('hand_pose', 'set_frame_size', {
      width: cal.frameSize.width,
      height: cal.frameSize.height,
    })
    .catch((err) => rt.log.warn('hand_pose.set_frame_size failed', { err: String(err) }));
  await rt.drivers
    .execute('hand_pose', 'set_surface_size', {
      width: surfaceSize.width,
      height: surfaceSize.height,
    })
    .catch((err) =>
      rt.log.warn('hand_pose.set_surface_size failed', { err: String(err) }),
    );
  await rt.drivers
    .execute('hand_pose', 'set_homography', cal.homographySurface)
    .catch((err) =>
      rt.log.warn('hand_pose.set_homography failed', { err: String(err) }),
    );
}
