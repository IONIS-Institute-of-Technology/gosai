/**
 * Whether the dashboard may start an app. An app that requires calibration
 * and isn't calibrated runs its calibration first, and starts only when that
 * saved a profile.
 */
export async function readyToStart(options: {
  readonly required: boolean;
  readonly isCalibrated: () => Promise<boolean>;
  readonly calibrate: () => Promise<boolean>;
}): Promise<boolean> {
  if (!options.required || (await options.isCalibrated())) return true;
  return options.calibrate();
}
