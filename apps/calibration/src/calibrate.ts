/**
 * Calibration runner entry. Loaded in both the projector (fullscreen) and
 * control windows; we branch on the `role` URL param, load the target app's
 * calibration module from `?target=<app>`, and delegate to that definition.
 *
 *   ?role=control  -> orchestrates the step machine and UI
 *   anything else  -> passive projector renderer
 *
 * Both roles use `rt.events` to coordinate. The dashboard listens for the
 * finish event to close both windows when calibration ends.
 */

import {
  CALIBRATION_STATUS_KEY,
  createStorageClient,
  defineExperience,
  isCameraProjectorSurfaceCalibrationDefinition,
  type CalibrationDefinition,
  type CalibrationRole,
  type CalibrationStepContext,
  type ExperienceRuntimeContext,
  type InstalledApp,
} from '@gosai/sdk';
import { detectRole } from './shared.js';
import {
  initProjectorState,
  startProjector,
  stopProjector,
  type ProjectorState,
} from './projector.js';
import { initControlState, startControl, stopControl, type ControlState } from './control.js';

type State = {
  role: CalibrationRole;
  context: CalibrationStepContext | null;
  definition: CalibrationDefinition | null;
  customState: unknown;
  projector: ProjectorState | null;
  control: ControlState | null;
};

export default defineExperience<State>({
  slug: 'calibrate',
  name: 'Calibration Runner',
  description: 'Generic per-app calibration runner.',

  init(): State {
    const role = detectRole();
    return {
      role,
      context: null,
      definition: null,
      customState: undefined,
      projector: null,
      control: null,
    };
  },

  async start(rt, state) {
    const targetAppSlug = detectTargetAppSlug();
    const { definition, statusKey } = await loadTargetCalibration(rt, targetAppSlug);
    const targetStorage = createStorageClient(targetAppSlug, rt.app.server, rt.app.serverBaseUrl);
    const context: CalibrationStepContext = {
      rt,
      role: state.role,
      targetAppSlug,
      targetStorage,
      serverBaseUrl: rt.app.serverBaseUrl,
      statusKey,
      events: rt.events,
      drivers: rt.drivers,
      log: rt.log,
      markComplete: async (status = {}) => {
        await targetStorage.set(statusKey, {
          ok: true,
          completedAt: Date.now(),
          kind: definition.kind ?? definition.slug,
          version: 1,
          ...status,
        });
      },
      finish: async (ok = true) => {
        if (ok) await context.markComplete();
        await rt.events.emit('wizard:finished', { ok });
      },
    };
    state.context = context;
    state.definition = definition;

    if (isCameraProjectorSurfaceCalibrationDefinition(definition)) {
      if (state.role === 'control') {
        const control = initControlState();
        state.control = control;
        await startControl(context, control, definition.options);
      } else {
        const projector = initProjectorState();
        state.projector = projector;
        await startProjector(context, projector, definition.options);
      }
      return;
    }

    if (!definition.start) {
      throw new Error(`Calibration definition ${definition.slug} has no start lifecycle`);
    }
    state.customState = definition.init
      ? await Promise.resolve(definition.init(context))
      : undefined;
    await Promise.resolve(definition.start(context, state.customState));
  },

  async stop(_rt, state) {
    if (state.control) {
      await stopControl(state.control);
    } else if (state.projector) {
      await stopProjector(state.projector);
    } else if (state.definition?.stop && state.context) {
      await Promise.resolve(state.definition.stop(state.context, state.customState));
    }
  },
});

function detectTargetAppSlug(): string {
  const params = new URLSearchParams(window.location.search);
  const target = params.get('target');
  if (!target) throw new Error('Missing calibration target app');
  return target;
}

async function loadTargetCalibration(
  rt: ExperienceRuntimeContext,
  targetAppSlug: string,
): Promise<{ definition: CalibrationDefinition; statusKey: string }> {
  const appsRes = await fetch(`${rt.app.serverBaseUrl}/v1/apps`);
  if (!appsRes.ok) throw new Error(`Cannot fetch apps list (${appsRes.status})`);
  const apps = (await appsRes.json()) as { apps: InstalledApp[] };
  const target = apps.apps.find((app) => app.manifest.slug === targetAppSlug);
  if (!target) throw new Error(`Calibration target app ${targetAppSlug} is not installed`);

  const calibration = target.manifest.calibration;
  if (!calibration?.required || !calibration.entry) {
    throw new Error(`App ${targetAppSlug} does not declare a calibration entry`);
  }

  const entryUrl = `${rt.app.serverBaseUrl}/v1/apps/${targetAppSlug}/static/${calibration.entry}`;
  const mod = (await import(/* @vite-ignore */ entryUrl)) as {
    default?: CalibrationDefinition;
  };
  if (!mod.default) {
    throw new Error(`Calibration module ${calibration.entry} has no default export`);
  }
  return {
    definition: mod.default,
    statusKey: calibration.statusKey ?? CALIBRATION_STATUS_KEY,
  };
}
