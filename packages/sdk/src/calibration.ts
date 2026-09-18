/**
 * Calibration for apps.
 *
 * An app declares how it is calibrated in its manifest:
 *
 * ```jsonc
 * "calibration": {
 *   "kind": "camera-projector-surface",
 *   "required": true,
 *   "options": { "surfaceSize": { "width": 1920, "height": 1080 } }
 * }
 * ```
 *
 * GOSAI runs built-in kinds itself and saves one profile per app. The app
 * reads it with {@link loadCameraProjectorSurfaceCalibration}, or
 * {@link loadCalibrationProfile} for any kind.
 *
 * An app with its own flow names one of its experiences in
 * `calibration.experience`. GOSAI opens it in a control window and a
 * projector window ({@link readCalibrationLaunch}); the flow saves with
 * {@link saveCalibrationProfile} and ends with {@link finishCalibration}.
 */

import {
  CalibrationKinds,
  CalibrationParams,
  CalibrationWizardTopics,
  type CalibrationProfile,
  type CalibrationResult,
  type CalibrationRole,
  type CameraProjectorSurfaceCalibration,
} from '@gosai/shared/calibration';
import type { ExperienceRuntimeContext } from './types.js';

export {
  BUILTIN_CALIBRATION_KINDS,
  CALIBRATION_PROFILE_KEY,
  CALIBRATION_PROFILE_VERSION,
  CALIBRATION_RUNNER,
  CalibrationKinds,
  CalibrationParams,
  CalibrationWizardTopics,
  DEFAULT_SURFACE_SIZE,
  calibrationFlow,
  isBuiltinCalibrationKind,
  isCalibrated,
} from '@gosai/shared/calibration';
export type {
  BuiltinCalibrationKind,
  CalibrationPoint,
  CalibrationProfile,
  CalibrationProfileInput,
  CalibrationQuad,
  CalibrationResult,
  CalibrationRole,
  CalibrationSize,
  CameraProjectorSurfaceCalibration,
  CameraProjectorSurfaceOptions,
  CameraProjectorSurfaceStep,
  CameraProjectorSurfaceStepCopy,
} from '@gosai/shared/calibration';

/** The parts of the runtime context the calibration helpers use. */
export type CalibrationRuntime = Pick<ExperienceRuntimeContext, 'app' | 'events'>;

export interface CalibrationProfileOptions {
  /**
   * The app whose profile to use. Defaults to the running app. A flow may
   * pass the app it was launched for, when its app holds `calibration:write`.
   */
  readonly appSlug?: string;
}

export interface LoadCalibrationProfileOptions extends CalibrationProfileOptions {
  /** Only return a profile of this kind. */
  readonly kind?: string;
}

/** The app's calibration profile, or `null` when none is saved (or it has another kind). */
export async function loadCalibrationProfile<D = unknown>(
  rt: CalibrationRuntime,
  options: LoadCalibrationProfileOptions = {},
): Promise<CalibrationProfile<string, D> | null> {
  const { profile } = await rt.app.server.request('calibration:get', {
    appSlug: options.appSlug ?? rt.app.appSlug,
  });
  if (!profile || (options.kind !== undefined && profile.kind !== options.kind)) return null;
  return profile as CalibrationProfile<string, D>;
}

/**
 * Replaces the app's calibration profile. `kind` must be the kind the app's
 * manifest declares; the server checks the data of built-in kinds.
 */
export async function saveCalibrationProfile<D>(
  rt: CalibrationRuntime,
  profile: { readonly kind: string; readonly data: D },
  options: CalibrationProfileOptions = {},
): Promise<CalibrationProfile<string, D>> {
  const saved = await rt.app.server.request('calibration:save', {
    appSlug: options.appSlug ?? rt.app.appSlug,
    profile,
  });
  return saved.profile as CalibrationProfile<string, D>;
}

/** The app's camera-projector-surface calibration, or `null` when it isn't calibrated. */
export async function loadCameraProjectorSurfaceCalibration(
  rt: CalibrationRuntime,
  options: CalibrationProfileOptions = {},
): Promise<CameraProjectorSurfaceCalibration | null> {
  const profile = await loadCalibrationProfile<CameraProjectorSurfaceCalibration>(rt, {
    ...options,
    kind: CalibrationKinds.CameraProjectorSurface,
  });
  return profile?.data ?? null;
}

export function saveCameraProjectorSurfaceCalibration(
  rt: CalibrationRuntime,
  data: CameraProjectorSurfaceCalibration,
  options: CalibrationProfileOptions = {},
): Promise<CalibrationProfile<string, CameraProjectorSurfaceCalibration>> {
  return saveCalibrationProfile(
    rt,
    { kind: CalibrationKinds.CameraProjectorSurface, data },
    options,
  );
}

export interface CalibrationLaunch {
  readonly role: CalibrationRole;
  /** The app being calibrated. The running app when the window names none. */
  readonly target: string;
  /**
   * GOSAI opened the window for a calibration flow, from the dashboard's
   * Calibrate button or a kiosk, and waits for {@link finishCalibration}.
   * `false` when the experience started some other way, such as the app's
   * own `rt.router.switchTo`: nothing waits for the result then, so the app
   * decides where to go when the flow ends.
   */
  readonly managed: boolean;
}

/** Which window of a calibration flow this is, for which app, and who opened it. */
export function readCalibrationLaunch(
  rt: Pick<ExperienceRuntimeContext, 'app'>,
): CalibrationLaunch {
  const params = rt.app.params;
  const role = params[CalibrationParams.Role];
  const target = params[CalibrationParams.Target];
  return {
    role: role === 'control' ? 'control' : 'projector',
    target: target ?? rt.app.appSlug,
    managed: role !== undefined || target !== undefined,
  };
}

/** Ends the flow. GOSAI closes its windows and reports the result to whoever started it. */
export function finishCalibration(
  rt: CalibrationRuntime,
  result: CalibrationResult,
): Promise<void> {
  return rt.events.emit(CalibrationWizardTopics.Finished, result);
}
