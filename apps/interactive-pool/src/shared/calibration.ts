/**
 * Pushes the calibration into the tracking drivers (`ball`, `hand_pose`) so
 * the coordinates they emit already live in the app's 1920x1080 reference
 * space. The calibration itself comes from `loadCameraProjectorSurfaceCalibration`.
 */

import type {
  CalibrationSize,
  CameraProjectorSurfaceCalibration,
  ExperienceRuntimeContext,
} from '@gosai/sdk';

/**
 * Configures both drivers. Each driver action is tried on its own, and a
 * failure is logged rather than thrown, so a missing or old driver leaves the
 * experience running uncorrected.
 */
export async function configureTrackingDrivers(
  rt: ExperienceRuntimeContext,
  cal: CameraProjectorSurfaceCalibration,
  fallbackSize: CalibrationSize,
): Promise<void> {
  const run = (name: string, action: Promise<unknown>): Promise<void> =>
    action.then(
      () => undefined,
      (err: unknown) => rt.log.warn(`${name} failed`, { err: String(err) }),
    );
  const size = ({ width, height }: CalibrationSize) => ({ width, height });

  // ball: camera -> surface when available, camera -> display otherwise, and
  // the output size matching whichever space that is.
  const ballOutput = cal.homographySurface ? cal.surfaceSize : fallbackSize;
  await run(
    'ball.set_homography',
    rt.drivers.execute('ball', 'set_homography', cal.homographySurface ?? cal.homography),
  );
  await run(
    'ball.set_output_size',
    rt.drivers.execute('ball', 'set_output_size', size(ballOutput)),
  );

  // hand_pose: warps MediaPipe landmarks into the surface space. Without a
  // surface homography it keeps emitting camera-normalised coordinates.
  if (!cal.homographySurface) return;
  if (!cal.frameSize) {
    rt.log.warn('hand_pose not configured: the calibration has no frame size');
    return;
  }
  await run(
    'hand_pose.set_frame_size',
    rt.drivers.execute('hand_pose', 'set_frame_size', size(cal.frameSize)),
  );
  await run(
    'hand_pose.set_surface_size',
    rt.drivers.execute('hand_pose', 'set_surface_size', size(cal.surfaceSize)),
  );
  await run(
    'hand_pose.set_homography',
    rt.drivers.execute('hand_pose', 'set_homography', cal.homographySurface),
  );
}
