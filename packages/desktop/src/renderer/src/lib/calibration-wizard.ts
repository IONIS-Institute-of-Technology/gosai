import type { ServerClient } from './server-client.js';

export const CALIBRATION_SLUG = 'calibration';

export async function runCalibrationWizard(client: ServerClient): Promise<void> {
  const api = window.gosai;
  if (!api) throw new Error('Electron API unavailable');

  const appSlug = CALIBRATION_SLUG;
  const experienceSlug = 'calibrate';
  await client.request('experience:start', { appSlug, experienceSlug });

  const display = await pickDisplay(client);
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
