/**
 * Kiosk-mode calibration. Replicates the dashboard's calibration wizard flow
 * (see renderer/src/lib/calibration-wizard.ts) from the Electron main
 * process, since kiosks have no dashboard:
 *
 * 1. Start the built-in `calibration` app's `calibrate` experience with the
 *    target app as driver binding (so it uses the target's camera).
 * 2. Open the control window and the fullscreen projector window.
 * 3. Follow `app:calibration:wizard:*` events over main's server connection,
 *    hiding the control window during background capture and tearing
 *    everything down when the wizard finishes.
 *
 * The resulting profile is written by the wizard into the target app's own
 * storage inside the kiosk home, so it persists across launches.
 */

import type { ServerClient } from '@gosai/shared/client';
import type { WindowRegistry } from './windows.js';

export const CALIBRATION_SLUG = 'calibration';
const CALIBRATE_EXPERIENCE = 'calibrate';
export const DEFAULT_CALIBRATION_STATUS_KEY = 'calibration_status';

export interface CalibrationSchema {
  required?: boolean;
  entry?: string;
  statusKey?: string;
}

/** True when the target app's calibration status key exists in storage. */
export async function isCalibrated(
  server: ServerClient,
  appSlug: string,
  statusKey: string,
): Promise<boolean> {
  try {
    return (await server.request('storage:get', { appSlug, key: statusKey })).found;
  } catch (err) {
    console.error(`[gosai-kiosk] could not read the calibration status: ${String(err)}`);
    return false;
  }
}

/** True when the calibration runner app is installed on the server. */
export async function hasCalibrationRunner(server: ServerClient): Promise<boolean> {
  try {
    const { apps } = await server.request('apps:list');
    return apps.some((a) => a.manifest.slug === CALIBRATION_SLUG);
  } catch (err) {
    console.error(`[gosai-kiosk] could not list apps: ${String(err)}`);
    return false;
  }
}

export interface RunKioskCalibrationOptions {
  readonly server: ServerClient;
  readonly windows: WindowRegistry;
  readonly targetAppSlug: string;
  readonly displayId: number;
}

/** Runs the wizard and resolves when it finishes or the operator closes it. */
export async function runKioskCalibration(options: RunKioskCalibrationOptions): Promise<void> {
  const { server, windows, targetAppSlug, displayId } = options;
  const driverBinding = targetAppSlug;

  await server.request('experience:start', {
    appSlug: CALIBRATION_SLUG,
    experienceSlug: CALIBRATE_EXPERIENCE,
    driverBinding,
  });

  // Control before projector, mirroring the dashboard flow (macOS tears down
  // a fullscreen window when an always-on-top window is created after it).
  const control = windows.openControlWindow({
    appSlug: CALIBRATION_SLUG,
    experienceSlug: CALIBRATE_EXPERIENCE,
    targetAppSlug,
    driverBinding,
    title: 'Calibration · Control',
    width: 960,
    height: 720,
  });
  const projector = windows.openAppHost({
    displayId,
    appSlug: CALIBRATION_SLUG,
    experienceSlug: CALIBRATE_EXPERIENCE,
    targetAppSlug,
    driverBinding,
    fullscreen: true,
  });

  await new Promise<void>((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      offStep();
      offFinished();
      // Tears down both windows and stops the experience on the server.
      windows.endExperience(CALIBRATION_SLUG, CALIBRATE_EXPERIENCE);
      resolve();
    };

    const offStep = server.on(`app:${CALIBRATION_SLUG}:wizard:step`, (payload) => {
      const step = (payload as { step?: unknown } | null)?.step;
      if (typeof step !== 'string') return;
      // The control window must not pollute the camera's view of the
      // projected pattern during background capture.
      windows.setControlWindowVisible(control.id, step !== 'background');
    });
    const offFinished = server.on(`app:${CALIBRATION_SLUG}:wizard:finished`, finish);

    // Operator closed a window manually: treat as the end of the wizard.
    projector.window.on('closed', finish);
    control.window.on('closed', finish);
  });
}
