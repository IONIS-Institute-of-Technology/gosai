/**
 * Runs an app's calibration flow from Electron main, for the dashboard (IPC
 * `gosai:calibration:run`) and for kiosks:
 *
 * 1. Reads the app's manifest `calibration` to find the flow: the built-in
 *    calibration app for built-in kinds, driven with the app's driver
 *    binding so it uses the app's camera, or the app's own `experience`.
 * 2. Starts the flow's experience and opens its control window, then its
 *    fullscreen projector window. Both get `role` and `target` params.
 * 3. Resolves with the flow's `wizard:finished` result, and closes both
 *    windows and stops the experience. Closing a window, a failed start or a
 *    lost server connection end the run too, so the caller never waits forever.
 *
 * No Electron import, so tests can drive it with fakes.
 */

import {
  CALIBRATION_RUNNER,
  CalibrationWizardTopics,
  calibrationFlow,
  type CalibrationResult,
} from '@gosai/shared/calibration';
import type { ServerClient } from '@gosai/shared/client';
import { appEventName } from '@gosai/shared/events';
import type { OpenAppHostOptions, OpenControlWindowOptions } from './windows.js';

export type CalibrationServer = Pick<ServerClient, 'ready' | 'request' | 'on' | 'onStatus'>;

export interface CalibrationWindowHandle {
  readonly window: { once(event: 'closed', listener: () => void): unknown };
}

/** The parts of the WindowRegistry the orchestrator uses. */
export interface CalibrationWindows {
  readonly server: CalibrationServer;
  openControlWindow(options: OpenControlWindowOptions): CalibrationWindowHandle;
  openAppHost(options: OpenAppHostOptions): CalibrationWindowHandle;
  /** Closes the experience's windows and stops it on the server. */
  endExperience(appSlug: string, experienceSlug: string): void;
  listDisplays(): readonly { readonly id: number }[];
  primaryDisplay(): { readonly id: number };
}

export interface RunCalibrationOptions {
  readonly appSlug: string;
  /**
   * Display of the projector window. Defaults to the app's display
   * assignment, then the global display, then the primary display.
   */
  readonly displayId?: number;
}

const CONNECT_TIMEOUT_MS = 10_000;

export class CalibrationOrchestrator {
  /** The app whose calibration is running. */
  private running: string | null = null;

  constructor(private readonly windows: CalibrationWindows) {}

  /** Runs one flow at a time. Never rejects. */
  run(options: RunCalibrationOptions): Promise<CalibrationResult> {
    if (this.running !== null) {
      return Promise.resolve({
        ok: false,
        error: `The calibration of ${this.running} is still running`,
      });
    }
    this.running = options.appSlug;
    return this.runFlow(options)
      .catch((err: unknown): CalibrationResult => ({ ok: false, error: errorMessage(err) }))
      .finally(() => {
        this.running = null;
      });
  }

  private async runFlow({ appSlug, displayId }: RunCalibrationOptions): Promise<CalibrationResult> {
    const server = this.windows.server;
    await server.ready(CONNECT_TIMEOUT_MS);
    const { apps } = await server.request('apps:list');
    const calibration = apps.find((a) => a.manifest.slug === appSlug)?.manifest.calibration;
    if (!calibration) {
      const installed = apps.some((a) => a.manifest.slug === appSlug);
      return {
        ok: false,
        error: installed
          ? `${appSlug} does not declare calibration`
          : `${appSlug} is not installed`,
      };
    }
    const flow = calibrationFlow(appSlug, calibration);
    const builtin = calibration.experience === undefined;
    if (builtin && !apps.some((a) => a.manifest.slug === CALIBRATION_RUNNER.appSlug)) {
      return { ok: false, error: 'The built-in calibration app is not installed' };
    }
    const projectorDisplay = displayId ?? (await this.resolveDisplay(server, appSlug));
    // The built-in runner uses the target's camera; a custom flow is the app itself.
    const driverBinding = builtin ? appSlug : undefined;

    return new Promise<CalibrationResult>((resolve) => {
      let finished = false;
      const cleanups: Array<() => void> = [];
      const finish = (result: CalibrationResult): void => {
        if (finished) return;
        finished = true;
        for (const cleanup of cleanups) cleanup();
        this.windows.endExperience(flow.appSlug, flow.experienceSlug);
        resolve(result);
      };

      cleanups.push(
        server.on(appEventName(flow.appSlug, CalibrationWizardTopics.Finished), (payload) =>
          finish(toResult(payload)),
        ),
        server.onStatus((status) => {
          if (status === 'disconnected') {
            finish({ ok: false, error: 'Lost the connection to the GOSAI server' });
          }
        }),
      );

      void (async () => {
        await server.request('experience:start', {
          appSlug: flow.appSlug,
          experienceSlug: flow.experienceSlug,
          ...(driverBinding ? { driverBinding } : {}),
        });
        if (finished) return;
        const closed = (): void =>
          finish({ ok: false, cancelled: true, error: 'The calibration window was closed' });
        const launch = { appSlug: flow.appSlug, experienceSlug: flow.experienceSlug };
        // Control first: on macOS, creating an always-on-top window after a
        // fullscreen one takes the fullscreen window out of fullscreen.
        this.windows
          .openControlWindow({
            ...launch,
            targetAppSlug: appSlug,
            ...(driverBinding ? { driverBinding } : {}),
            title: `Calibration · ${appSlug}`,
            width: 960,
            height: 720,
          })
          .window.once('closed', closed);
        this.windows
          .openAppHost({
            ...launch,
            displayId: projectorDisplay,
            targetAppSlug: appSlug,
            ...(driverBinding ? { driverBinding } : {}),
            fullscreen: true,
          })
          .window.once('closed', closed);
      })().catch((err: unknown) => finish({ ok: false, error: errorMessage(err) }));
    });
  }

  private async resolveDisplay(server: CalibrationServer, appSlug: string): Promise<number> {
    const known = new Set(this.windows.listDisplays().map((display) => display.id));
    const settings = await server.request('app:config:get', { appSlug }).catch(() => null);
    const assigned = settings?.display?.id;
    if (assigned != null && known.has(assigned)) return assigned;
    const config = await server.request('config:get').catch(() => null);
    if (config?.displayId != null && known.has(config.displayId)) return config.displayId;
    return this.windows.primaryDisplay().id;
  }
}

/** Flows run app code, so their result is checked rather than trusted. */
function toResult(payload: unknown): CalibrationResult {
  const value = (payload ?? {}) as { ok?: unknown; error?: unknown; cancelled?: unknown };
  if (value.ok === true) return { ok: true };
  return {
    ok: false,
    error: typeof value.error === 'string' && value.error ? value.error : 'Calibration failed',
    ...(value.cancelled === true ? { cancelled: true } : {}),
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
