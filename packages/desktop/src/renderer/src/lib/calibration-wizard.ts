import type { AppDeviceSettings, DisplayMode } from '@gosai/shared';
import type { ServerClient } from './server-client.js';

export const CALIBRATION_SLUG = 'calibration';
const SERVER_BASE_URL = 'http://127.0.0.1:7777';
/** Must match `CALIBRATION_TARGET_KEY` in the calibration app's shared.ts. */
const CALIBRATION_TARGET_STORAGE_KEY = '__target';

/**
 * Run the calibration wizard. When `targetApp` is provided the resulting
 * profile is namespaced to that app slug and the projector opens on that app's
 * assigned display; otherwise a legacy (global) profile is written.
 */
export async function runCalibrationWizard(
  client: ServerClient,
  targetApp?: string,
): Promise<void> {
  const api = window.gosai;
  if (!api) throw new Error('Electron API unavailable');

  const appSlug = CALIBRATION_SLUG;
  const experienceSlug = 'calibrate';

  // Tell the wizard windows which app's profile to read/write before they boot.
  await setCalibrationTarget(targetApp ?? null);

  await client.request('experience:start', { appSlug, experienceSlug });

  const display = targetApp
    ? (await pickDisplayForApp(client, targetApp)).display
    : await pickDisplay(client);
  if (!display) throw new Error('No display available for calibration');

  // Open control before the projector so macOS does not tear down the
  // fullscreen window when the always-on-top control window is created.
  const control = await api.controlWindow.open({
    appSlug,
    experienceSlug,
    projectorDisplayId: display.id,
    title: 'Calibration · Control',
    width: 960,
    height: 720,
  });

  const projector = await api.appHost.open({
    displayId: display.id,
    appSlug,
    experienceSlug,
    fullscreen: true,
  });

  let finished = false;
  const finish = async (): Promise<void> => {
    if (finished) return;
    finished = true;
    offStep();
    offWizardFinished();
    offExperienceEnded();
    try {
      await api.controlWindow.close(control.windowId);
    } catch {
      // ignore
    }
    try {
      await api.appHost.close(projector.windowId);
    } catch {
      // ignore
    }
    try {
      await client.request('experience:stop', { appSlug, experienceSlug });
    } catch {
      // ignore
    }
    await setCalibrationTarget(null);
  };

  const offStep = client.on(`app:${appSlug}:wizard:step`, async (payload) => {
    const data = payload as { step?: string };
    if (!data?.step) return;
    if (data.step === 'background') {
      try {
        await api.controlWindow.hide(control.windowId);
      } catch {
        // ignore
      }
    } else {
      try {
        await api.controlWindow.show(control.windowId);
      } catch {
        // ignore
      }
    }
  });

  const offWizardFinished = client.on(`app:${appSlug}:wizard:finished`, () => {
    void finish();
  });

  const offExperienceEnded = api.onExperienceEnded((payload) => {
    if (payload.appSlug === appSlug && payload.experienceSlug === experienceSlug) {
      void finish();
    }
  });
}

/** Publish (or clear) the calibration target slug the wizard windows read. */
async function setCalibrationTarget(target: string | null): Promise<void> {
  const url = `${SERVER_BASE_URL}/v1/apps/${CALIBRATION_SLUG}/storage/${CALIBRATION_TARGET_STORAGE_KEY}`;
  try {
    if (target) {
      await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(target),
      });
    } else {
      await fetch(url, { method: 'DELETE' });
    }
  } catch {
    // Best-effort: the wizard falls back to legacy unscoped keys.
  }
}

export async function pickDisplay(
  client: ServerClient,
): Promise<{ id: number; label: string } | null> {
  const api = window.gosai;
  if (!api) return null;
  const { displays, primary } = await api.displays.list();
  if (displays.length <= 1) return primary;

  try {
    const config = (await client.request('config:get')) as { displayId?: number | null };
    if (config.displayId != null) {
      const match = displays.find((d) => d.id === config.displayId);
      if (match) return match;
    }
  } catch {
    // Fall through to primary if config fetch fails.
  }
  return primary;
}

/**
 * Resolve which display (and fullscreen/windowed mode) an app's window should
 * open on, honouring the app's per-app settings and falling back to the global
 * display selection. Displays are shareable, so two apps may pick the same one.
 */
export async function pickDisplayForApp(
  client: ServerClient,
  appSlug: string,
): Promise<{ display: { id: number; label: string } | null; mode: DisplayMode }> {
  const api = window.gosai;
  if (!api) return { display: null, mode: 'fullscreen' };

  let settings: AppDeviceSettings = {};
  try {
    settings = (await client.request('app:config:get', { appSlug })) as AppDeviceSettings;
  } catch {
    // No per-app settings yet.
  }
  const mode = settings.display?.mode ?? 'fullscreen';
  const desiredId = settings.display?.id;

  if (desiredId != null) {
    const { displays } = await api.displays.list();
    const match = displays.find((d) => d.id === desiredId);
    if (match) return { display: match, mode };
  }

  const fallback = await pickDisplay(client);
  return { display: fallback, mode };
}
