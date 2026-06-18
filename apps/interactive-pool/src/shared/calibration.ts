/**
 * Calibration data loader + driver configuration helpers.
 *
 * Reads this app's calibration profile and pushes the relevant pieces into
 * the tracking drivers (`ball`, `hand_pose`) so their emitted coordinates
 * already live in the app's 1920x1080 reference space. Also exposes the focus
 * quad in projector coordinates so the compositor can warp the canvas to land
 * on the physical surface exactly.
 */

import {
  loadCameraProjectorSurfaceCalibration,
  type CameraProjectorSurfaceCalibrationProfile,
  type ExperienceRuntimeContext,
  type SizeXY,
} from '@gosai/sdk';

export type CalibrationData = CameraProjectorSurfaceCalibrationProfile;

export async function loadCalibration(rt: ExperienceRuntimeContext): Promise<CalibrationData> {
  return loadCameraProjectorSurfaceCalibration(rt);
}

/**
 * Configure the `ball` driver from the loaded calibration:
 *
 *   - `set_homography`: camera -> surface reference space so YOLO detections
 *     are warped into our 1920x1080 reference space (falls back to the
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
  const outputSize = cal.homographySurface ? (cal.surfaceSize ?? fallbackSize) : fallbackSize;

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
    // camera-normalised coords. Nothing to configure.
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
    .catch((err) => rt.log.warn('hand_pose.set_surface_size failed', { err: String(err) }));
  await rt.drivers
    .execute('hand_pose', 'set_homography', cal.homographySurface)
    .catch((err) => rt.log.warn('hand_pose.set_homography failed', { err: String(err) }));
}
