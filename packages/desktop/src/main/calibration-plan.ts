/**
 * Kiosk calibration decisions, from the app's manifest as read from disk.
 * No Electron import, so tests and the packaging script can use them.
 */

import { upgradeLegacyCalibration, type AppCalibrationSchema } from '@gosai/shared/calibration';

type DeclaredCalibration = Partial<Pick<AppCalibrationSchema, 'required' | 'experience'>>;

/**
 * The manifest's `calibration` as the server reads it, with the pre-kind
 * shapes converted, or `null` when the app declares none. The server
 * validates the rest.
 */
function declaredCalibration(calibration: unknown): DeclaredCalibration | null {
  const upgraded = upgradeLegacyCalibration(calibration).calibration;
  return typeof upgraded === 'object' && upgraded !== null
    ? (upgraded as DeclaredCalibration)
    : null;
}

/** Whether the app calibrates with the built-in calibration app, which then has to ship with it. */
export function usesCalibrationRunner(calibration: unknown): boolean {
  const declared = declaredCalibration(calibration);
  return declared !== null && declared.experience === undefined;
}

export type KioskCalibrationPlan =
  /** Run the flow before the app starts. */
  | 'run'
  /** Start the app right away. */
  | 'skip'
  /** Calibration was forced, but the app declares none. */
  | 'undeclared';

/**
 * A kiosk calibrates on first boot when the app requires it and isn't
 * calibrated yet, and whenever calibration is forced. `isCalibrated` is only
 * asked when it matters.
 */
export async function planKioskCalibration(
  calibration: unknown,
  options: { readonly force: boolean; readonly isCalibrated: () => Promise<boolean> },
): Promise<KioskCalibrationPlan> {
  const declared = declaredCalibration(calibration);
  if (!declared) return options.force ? 'undeclared' : 'skip';
  if (options.force) return 'run';
  if (declared.required !== true) return 'skip';
  return (await options.isCalibrated()) ? 'skip' : 'run';
}
