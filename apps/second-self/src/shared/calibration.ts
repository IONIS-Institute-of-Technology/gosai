/**
 * The mirror calibration: a calibration kind of Second Self's own, run by its
 * calibration experience (src/calibrate.ts) and saved as the app's
 * calibration profile, which holds a {@link MirrorProfile}.
 *
 * GOSAI opens it from the dashboard's Calibrate button, in two windows: the
 * projector window on the mirror and a control window with the keyboard. The
 * flow ends with `finishCalibration`, and GOSAI closes both. Nothing in the
 * app walks into the calibration by itself: a mirror with no rig draws
 * directly and says so.
 *
 * The camera intrinsics are saved beside it, under the app's own
 * {@link LENS_PROFILE_KEY}, because they belong to the camera and outlive any
 * one mirror calibration.
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
import {
  parseMirrorProfile,
  parseStoredLens,
  type MirrorProfile,
  type StoredLens,
} from './config.js';

/** The profile kind and the experience that runs the calibration. */
export const MIRROR_CALIBRATION = manifest.calibration;

/**
 * Where the camera intrinsics live, in the app's own storage rather than in
 * the calibration profile: they belong to the camera, so a new mirror
 * calibration reuses them and only a camera change invalidates them.
 */
export const LENS_PROFILE_KEY = 'lens_profile';

export const CALIBRATION_CANCELLED: CalibrationResult = {
  ok: false,
  cancelled: true,
  error: 'Calibration cancelled',
};

/**
 * The saved mirror profile, or `null`. A profile written by an older
 * calibration no longer describes a rig this app can project through, so it is
 * ignored with one warning: the mirror counts as uncalibrated.
 */
export async function loadMirrorProfile(
  rt: ExperienceRuntimeContext,
): Promise<MirrorProfile | null> {
  try {
    const saved = await loadCalibrationProfile(rt, { kind: MIRROR_CALIBRATION.kind });
    if (!saved) return null;
    const profile = parseMirrorProfile(saved.data);
    if (!profile) {
      rt.log.warn('second-self: the saved mirror profile is unusable, calibrate the rig again');
    }
    return profile;
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

/**
 * The saved camera intrinsics, or `null` when none were saved or what was
 * saved no longer parses. A missing lens is normal on a first run: the wizard
 * then calibrates one.
 */
export async function loadLensProfile(rt: ExperienceRuntimeContext): Promise<StoredLens | null> {
  try {
    const saved = await rt.storage.get(LENS_PROFILE_KEY);
    if (saved === undefined) return null;
    const lens = parseStoredLens(saved);
    if (!lens) rt.log.warn('second-self: the saved lens profile is unusable, ignoring it');
    return lens;
  } catch (err) {
    rt.log.warn('second-self: failed to read the lens profile', { err: String(err) });
    return null;
  }
}

export async function saveLensProfile(
  rt: ExperienceRuntimeContext,
  stored: StoredLens,
): Promise<void> {
  await rt.storage.set(LENS_PROFILE_KEY, stored);
}

/**
 * Ends the calibration experience. GOSAI's flow gets the result and closes the
 * windows; a run that was started some other way goes back to main, which is
 * also how the notice about starting it from the dashboard ends.
 */
export async function endCalibration(
  rt: ExperienceRuntimeContext,
  launch: CalibrationLaunch,
  result: CalibrationResult,
): Promise<void> {
  if (launch.managed) await finishCalibration(rt, result);
  else await rt.router.switchTo(manifest.default);
}
