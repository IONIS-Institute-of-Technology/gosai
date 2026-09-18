/**
 * The mirror calibration: a calibration kind of Second Self's own, run by its
 * calibration experience (src/calibrate.ts) and saved as the app's
 * calibration profile, which holds a {@link MirrorProfile}.
 *
 * Two ways lead into the experience:
 *
 * - GOSAI opens it for the dashboard's Calibrate button or a kiosk. The flow
 *   ends with `finishCalibration`, and GOSAI closes its windows.
 * - The menu, and main starting on a mirror rig without a profile, switch to
 *   it with `rt.router.switchTo`. It switches back to main when it ends.
 */

import {
  finishCalibration,
  loadCalibrationProfile,
  saveCalibrationProfile,
  type CalibrationLaunch,
  type CalibrationResult,
  type ExperienceRuntimeContext,
} from '@gosai/sdk';
import manifest from '../../gosai.app.json';
import { parseMirrorProfile, type MirrorProfile, type SecondSelfConfig } from './config.js';

/** The profile kind and the experience that runs the calibration. */
export const MIRROR_CALIBRATION = manifest.calibration;

/** Where the profile lived before calibration profiles. The first read converts it. */
export const LEGACY_PROFILE_KEY = 'mirror_calibration';

/**
 * Set when the user leaves the calibration without saving, however it was
 * opened, so main's next start doesn't send them straight back into it.
 */
export const CALIBRATION_LEFT_KEY = 'calibration_left';

export const CALIBRATION_CANCELLED: CalibrationResult = {
  ok: false,
  cancelled: true,
  error: 'Calibration cancelled',
};

/**
 * The saved mirror profile, or `null`. An install calibrated before
 * calibration profiles has it under {@link LEGACY_PROFILE_KEY}: the first read
 * saves it as the profile and removes the old key.
 */
export async function loadMirrorProfile(
  rt: ExperienceRuntimeContext,
): Promise<MirrorProfile | null> {
  try {
    const saved = await loadCalibrationProfile(rt, { kind: MIRROR_CALIBRATION.kind });
    if (saved) return parseMirrorProfile(saved.data);
    return await convertLegacyProfile(rt);
  } catch (err) {
    rt.log.warn('second-self: failed to read the mirror profile', { err: String(err) });
    return null;
  }
}

export async function saveMirrorProfile(
  rt: ExperienceRuntimeContext,
  profile: MirrorProfile,
): Promise<void> {
  await saveCalibrationProfile(rt, { kind: MIRROR_CALIBRATION.kind, data: profile });
}

async function convertLegacyProfile(rt: ExperienceRuntimeContext): Promise<MirrorProfile | null> {
  const legacy = parseMirrorProfile(await rt.storage.get(LEGACY_PROFILE_KEY));
  if (!legacy) return null;
  try {
    await saveMirrorProfile(rt, legacy);
    await rt.storage.remove(LEGACY_PROFILE_KEY);
    rt.log.info('second-self: converted the stored mirror calibration into a profile');
  } catch (err) {
    // The old key still works; the next start tries again.
    rt.log.warn('second-self: could not convert the stored mirror calibration', {
      err: String(err),
    });
  }
  return legacy;
}

/** Leaves main for the calibration experience. */
export function openCalibration(rt: ExperienceRuntimeContext): void {
  rt.router.switchTo(MIRROR_CALIBRATION.experience).catch((err: unknown) => {
    rt.log.error('second-self: could not start the calibration', { err: String(err) });
  });
}

/**
 * Ends the calibration experience. GOSAI's flow gets the result and closes
 * the windows; a run the app started goes back to main. When nothing was
 * saved, main is told not to send the user straight back.
 */
export async function endCalibration(
  rt: ExperienceRuntimeContext,
  launch: CalibrationLaunch,
  result: CalibrationResult,
): Promise<void> {
  if (!result.ok) {
    await rt.storage.set(CALIBRATION_LEFT_KEY, true).catch((err: unknown) => {
      rt.log.warn('second-self: could not note that the calibration was left', {
        err: String(err),
      });
    });
  }
  if (launch.managed) await finishCalibration(rt, result);
  else await rt.router.switchTo(manifest.default);
}

/**
 * Whether main should switch to the calibration as it starts: a mirror rig
 * without a profile can't line the skeleton up with the reflection. Not right
 * after the user left the calibration without saving; that note is used up.
 */
export async function shouldCalibrateFirst(
  rt: ExperienceRuntimeContext,
  config: SecondSelfConfig,
  profile: MirrorProfile | null,
): Promise<boolean> {
  let left = false;
  try {
    left = (await rt.storage.get(CALIBRATION_LEFT_KEY)) !== undefined;
    if (left) await rt.storage.remove(CALIBRATION_LEFT_KEY);
  } catch (err) {
    rt.log.warn('second-self: could not read whether the calibration was left', {
      err: String(err),
    });
  }
  return !left && config.projection.mode === 'reflection' && profile === null;
}
