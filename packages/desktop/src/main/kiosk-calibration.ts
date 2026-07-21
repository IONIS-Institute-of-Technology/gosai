/**
 * Kiosk-mode calibration. Replicates the dashboard's calibration wizard flow
 * (see renderer/src/lib/calibration-wizard.ts) from the Electron main
 * process, since kiosks have no dashboard:
 *
 * 1. Start the built-in `calibration` app's `calibrate` experience with the
 *    target app as driver binding (so it uses the target's camera).
 * 2. Open the control window and the fullscreen projector window.
 * 3. Follow `app:calibration:wizard:*` events over a WebSocket connection to
 *    the embedded server - hiding the control window during background
 *    capture and tearing everything down when the wizard finishes.
 *
 * The resulting profile is written by the wizard into the target app's own
 * storage inside the kiosk home, so it persists across launches.
 */

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
  baseUrl: string,
  appSlug: string,
  statusKey: string,
): Promise<boolean> {
  try {
    const res = await fetch(
      `${baseUrl}/v1/apps/${appSlug}/storage/${encodeURIComponent(statusKey)}`,
    );
    return res.status === 200;
  } catch {
    return false;
  }
}

/** True when the calibration runner app is installed on the server. */
export async function hasCalibrationRunner(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/v1/apps`);
    if (!res.ok) return false;
    const data = (await res.json()) as { apps: Array<{ manifest: { slug: string } }> };
    return data.apps.some((a) => a.manifest.slug === CALIBRATION_SLUG);
  } catch {
    return false;
  }
}

export interface RunKioskCalibrationOptions {
  readonly baseUrl: string;
  readonly windows: WindowRegistry;
  readonly targetAppSlug: string;
  readonly displayId: number;
}

/** Runs the wizard and resolves when it finishes or the operator closes it. */
export async function runKioskCalibration(options: RunKioskCalibrationOptions): Promise<void> {
  const { baseUrl, windows, targetAppSlug, displayId } = options;
  const driverBinding = targetAppSlug;

  const startRes = await fetch(`${baseUrl}/v1/experiences/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      appSlug: CALIBRATION_SLUG,
      experienceSlug: CALIBRATE_EXPERIENCE,
      driverBinding,
    }),
  });
  if (!startRes.ok) {
    throw new Error(`could not start calibration experience: ${await startRes.text()}`);
  }

  const events = new EventSocket(`${baseUrl.replace(/^http/, 'ws')}/ws`);
  await events.connect();
  events.subscribe([
    `app:${CALIBRATION_SLUG}:wizard:step`,
    `app:${CALIBRATION_SLUG}:wizard:finished`,
  ]);

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
      events.close();
      // Tears down both windows and stops the experience on the server.
      windows.endExperience(CALIBRATION_SLUG, CALIBRATE_EXPERIENCE);
      resolve();
    };

    events.on(`app:${CALIBRATION_SLUG}:wizard:step`, (payload) => {
      const step = (payload as { step?: string } | null)?.step;
      if (!step) return;
      // The control window must not pollute the camera's view of the
      // projected pattern during background capture.
      windows.setControlWindowVisible(control.id, step !== 'background');
    });
    events.on(`app:${CALIBRATION_SLUG}:wizard:finished`, finish);

    // Operator closed a window manually: treat as the end of the wizard.
    projector.window.on('closed', finish);
    control.window.on('closed', finish);
  });
}

/**
 * Minimal WebSocket event listener speaking the GOSAI server protocol. Only
 * supports subscribe + event dispatch - enough for the calibration flow.
 * Uses the WebSocket client built into Electron's Node runtime.
 */
class EventSocket {
  private ws: WebSocket | null = null;
  private readonly listeners = new Map<string, (payload: unknown) => void>();

  constructor(private readonly url: string) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error(`WebSocket failed: ${this.url}`)));
      ws.addEventListener('message', (ev) => {
        let parsed: { type?: string; payload?: unknown };
        try {
          parsed = JSON.parse(String(ev.data)) as typeof parsed;
        } catch {
          return;
        }
        if (!parsed.type) return;
        this.listeners.get(parsed.type)?.(parsed.payload);
      });
    });
  }

  subscribe(eventNames: string[]): void {
    this.ws?.send(JSON.stringify({ v: 1, type: 'subscribe', payload: { events: eventNames } }));
  }

  on(event: string, listener: (payload: unknown) => void): void {
    this.listeners.set(event, listener);
  }

  close(): void {
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
    this.ws = null;
  }
}
