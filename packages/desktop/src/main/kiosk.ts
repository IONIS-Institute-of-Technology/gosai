/**
 * Kiosk mode: boot straight into a single app, no dashboard. See
 * kiosk-config.ts for how it is switched on and configured.
 *
 * Each kiosk owns an isolated data directory (GOSAI_HOME, defaulting to
 * ~/.gosai-kiosks/<slug>) holding its config, storage, logs, and Electron
 * profile, and starts its own embedded server on an ephemeral port. Several
 * kiosks therefore coexist on one machine without any port coordination.
 *
 * A kiosk exits with a non-zero code when its server or a renderer dies, so
 * a supervisor such as systemd restarts it.
 */

import { existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { app, screen } from 'electron';
import { bootRuntime, showBootWarnings } from './boot.js';
import { reportUnauthorized } from './server-auth.js';
import type { ServerRunner } from './server-runner.js';
import type { SplashWindow } from './splash.js';
import type { KioskConfig } from './kiosk-config.js';
import {
  DEFAULT_CALIBRATION_STATUS_KEY,
  hasCalibrationRunner,
  isCalibrated,
  runKioskCalibration,
  serverHeaders,
  type ServerAccess,
} from './kiosk-calibration.js';
import type { WindowRegistry } from './windows.js';

/**
 * Isolates this instance's Electron profile so several kiosks (or a kiosk and
 * the regular desktop) never fight over the same Chromium profile lock.
 * Must be called before `app.whenReady()`.
 */
export function applyKioskPaths(config: KioskConfig): void {
  mkdirSync(config.homeDir, { recursive: true });
  app.setPath('userData', join(config.homeDir, 'electron'));
}

export interface RunKioskOptions {
  readonly config: KioskConfig;
  readonly windows: WindowRegistry;
  readonly dashboardToken: string;
  readonly splash: SplashWindow;
}

/**
 * The server discovers built-in apps by scanning a directory of app folders.
 * Packaged kiosks already ship `resources/apps/<slug>`; for CLI launches we
 * mirror the single app directory into the kiosk home via a symlink.
 */
function prepareAppsDir(config: KioskConfig): string {
  if (app.isPackaged && config.appDir.startsWith(process.resourcesPath)) {
    return dirname(config.appDir);
  }
  const appsDir = join(config.homeDir, 'kiosk-apps');
  mkdirSync(appsDir, { recursive: true });
  linkApp(appsDir, config.manifest.slug, config.appDir);

  // Apps that declare calibration need the built-in calibration runner. For
  // CLI launches, pick it up from a sibling directory (the repo layout).
  if (config.manifest.calibration) {
    const sibling = join(dirname(config.appDir), 'calibration');
    if (existsSync(join(sibling, 'gosai.app.json'))) {
      linkApp(appsDir, 'calibration', sibling);
    }
  }
  return appsDir;
}

function linkApp(appsDir: string, slug: string, target: string): void {
  const link = join(appsDir, slug);
  try {
    rmSync(link, { recursive: true, force: true });
  } catch {
    // stale link removal is best-effort
  }
  // Junctions need no privileges on Windows; other platforms ignore the type.
  symlinkSync(target, link, 'junction');
}

/**
 * Boots the kiosk: Python runtime, embedded server, calibration when needed,
 * the experience and its window. Returns the server runner so the caller can
 * stop it on quit. Throws when the server can't start.
 */
export async function runKiosk(options: RunKioskOptions): Promise<ServerRunner> {
  const { config, windows, dashboardToken, splash } = options;

  const runtime = await bootRuntime({
    dashboardToken,
    splash,
    pythonExtras: config.pythonExtras,
    homeDir: config.homeDir,
    builtinAppsDir: prepareAppsDir(config),
  });
  const serverRunner = runtime.runner;
  serverRunner.onUnexpectedExit((description) => {
    console.error(`[gosai-kiosk] the server ${description}; exiting`);
    app.exit(1);
  });
  await showBootWarnings('kiosk', splash, runtime.warnings);
  splash.close();

  const { address } = runtime;
  windows.setServerAddress(address);
  const server: ServerAccess = {
    baseUrl: `http://${address.host}:${address.port}`,
    token: dashboardToken,
  };

  const appSlug = config.manifest.slug;
  const displays = screen.getAllDisplays();
  const display =
    config.displayIndex !== undefined
      ? (displays[config.displayIndex] ?? screen.getPrimaryDisplay())
      : screen.getPrimaryDisplay();

  await maybeCalibrate(config, windows, server, display.id);

  const started = await startExperienceWithRetry(server, appSlug, config.experienceSlug);
  if (!started) {
    console.error(
      `[gosai-kiosk] could not start ${appSlug}/${config.experienceSlug} on the server; ` +
        'opening the window anyway so the error is visible',
    );
  }

  const handle = windows.openAppHost({
    displayId: display.id,
    appSlug,
    experienceSlug: config.experienceSlug,
    fullscreen: config.fullscreen,
  });

  handle.window.on('closed', () => {
    app.quit();
  });

  console.log(
    `[gosai-kiosk] ${config.manifest.name ?? appSlug} (${basename(config.appDir)}) ` +
      `running on ${server.baseUrl}, home=${config.homeDir}`,
  );
  return serverRunner;
}

/**
 * Runs the calibration wizard before the app starts when the app requires
 * calibration and no profile exists yet (first boot on-site), or when this
 * launch was started with --kiosk-calibrate / GOSAI_KIOSK_CALIBRATE=1.
 */
async function maybeCalibrate(
  config: KioskConfig,
  windows: WindowRegistry,
  server: ServerAccess,
  displayId: number,
): Promise<void> {
  const schema = config.manifest.calibration;
  const required = schema?.required === true;
  if (!required && !config.forceCalibrate) return;

  const appSlug = config.manifest.slug;
  const statusKey = schema?.statusKey ?? DEFAULT_CALIBRATION_STATUS_KEY;
  if (!config.forceCalibrate && (await isCalibrated(server, appSlug, statusKey))) return;

  if (!(await hasCalibrationRunner(server))) {
    console.error(
      `[gosai-kiosk] ${appSlug} needs calibration but the calibration runner app is not ` +
        'bundled; repackage with a manifest that declares "calibration"',
    );
    return;
  }

  console.log(`[gosai-kiosk] running calibration wizard for ${appSlug}`);
  try {
    await runKioskCalibration({ server, windows, targetAppSlug: appSlug, displayId });
    console.log('[gosai-kiosk] calibration wizard closed');
  } catch (err) {
    console.error(`[gosai-kiosk] calibration failed: ${String(err)}`);
  }
}

async function startExperienceWithRetry(
  server: ServerAccess,
  appSlug: string,
  experienceSlug: string,
  attempts = 3,
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`${server.baseUrl}/v1/experiences/start`, {
        method: 'POST',
        headers: serverHeaders(server, { 'content-type': 'application/json' }),
        body: JSON.stringify({ appSlug, experienceSlug }),
      });
      if (res.ok) return true;
      reportUnauthorized(res.status);
      console.error(`[gosai-kiosk] experience start failed (${res.status}): ${await res.text()}`);
    } catch (err) {
      console.error(`[gosai-kiosk] experience start attempt ${i + 1} failed: ${String(err)}`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}
