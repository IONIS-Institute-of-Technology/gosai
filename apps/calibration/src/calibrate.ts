/**
 * The calibration runner. GOSAI opens it in two windows for an app whose
 * manifest declares a built-in calibration kind, with `role=control` or
 * `role=projector` and `target=<app slug>`:
 *
 * - the control window runs the wizard and saves the target's profile,
 * - the projector window draws the markers and the preview.
 *
 * Whatever stops a window from starting is reported as the flow's result,
 * so the windows close instead of waiting for an operator.
 */

import {
  CALIBRATION_RUNNER,
  CalibrationKinds,
  defineExperience,
  finishCalibration,
  readCalibrationLaunch,
  type CameraProjectorSurfaceOptions,
  type ExperienceRuntimeContext,
} from '@gosai/sdk';
import { startControl } from './control.js';
import { startProjector } from './projector.js';

export interface CalibrationTarget {
  readonly appSlug: string;
  readonly options: CameraProjectorSurfaceOptions;
}

interface State {
  stop: (() => void) | null;
}

export default defineExperience<State>({
  init: () => ({ stop: null }),

  async start(rt, state) {
    const { role } = readCalibrationLaunch(rt);
    try {
      const target = await loadTarget(rt);
      state.stop =
        role === 'control' ? await startControl(rt, target) : await startProjector(rt, target);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      await finishCalibration(rt, { ok: false, error }).catch(() => undefined);
      throw err;
    }
  },

  stop(_rt, state) {
    state.stop?.();
  },
});

/** The app the windows were opened for, and its camera-projector-surface options. */
export async function loadTarget(
  rt: Pick<ExperienceRuntimeContext, 'app'>,
): Promise<CalibrationTarget> {
  const { target } = readCalibrationLaunch(rt);
  if (target === CALIBRATION_RUNNER.appSlug) {
    throw new Error('The calibration window was opened without a target app');
  }
  const { apps } = await rt.app.server.request('apps:list');
  const calibration = apps.find((app) => app.manifest.slug === target)?.manifest.calibration;
  if (!calibration) throw new Error(`${target} is not installed or declares no calibration`);
  if (calibration.kind !== CalibrationKinds.CameraProjectorSurface) {
    throw new Error(`The calibration app can't run the ${calibration.kind} kind of ${target}`);
  }
  // The server checked the options of built-in kinds when it parsed the manifest.
  return {
    appSlug: target,
    options: (calibration.options ?? {}) as CameraProjectorSurfaceOptions,
  };
}
