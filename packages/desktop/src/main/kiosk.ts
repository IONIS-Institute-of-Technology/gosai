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
import type { ServerClient } from '@gosai/shared/client';
import { bootRuntime, showBootWarnings } from './boot.js';
import type { ServerRunner } from './server-runner.js';
import type { SplashWindow } from './splash.js';
import type { KioskConfig } from './kiosk-config.js';
import type { CalibrationOrchestrator } from './calibration.js';
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
  readonly calibration: CalibrationOrchestrator;
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

  // Built-in calibration kinds run in the built-in calibration app. For CLI
  // launches, pick it up from a sibling directory (the repo layout).
  const calibration = config.manifest.calibration;
  if (calibration && calibration.experience === undefined) {
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
  const { config, windows, calibration, dashboardToken, splash } = options;

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
  const server = windows.server;
  // The steps below report their own failures; the window still opens.
  await server.ready(30_000).catch((err: unknown) => {
    console.error(`[gosai-kiosk] could not connect to the embedded server: ${String(err)}`);
  });

  const appSlug = config.manifest.slug;
  const displays = screen.getAllDisplays();
  const display =
    config.displayIndex !== undefined
      ? (displays[config.displayIndex] ?? screen.getPrimaryDisplay())
      : screen.getPrimaryDisplay();

  await maybeCalibrate(config, calibration, server, display.id);

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
      `running on ${windows.serverBaseUrl}, home=${config.homeDir}`,
  );
  return serverRunner;
}

/**
 * Runs the calibration flow before the app starts when the app requires
 * calibration and isn't calibrated yet (first boot on-site), or when this
 * launch was started with --kiosk-calibrate / GOSAI_KIOSK_CALIBRATE=1. The
 * app starts afterwards whatever the result, so an unattended kiosk never
 * stays blank.
 */
async function maybeCalibrate(
  config: KioskConfig,
  calibration: CalibrationOrchestrator,
  server: ServerClient,
  displayId: number,
): Promise<void> {
  const appSlug = config.manifest.slug;
  if (!config.manifest.calibration) {
    if (config.forceCalibrate) {
      console.error(`[gosai-kiosk] ${appSlug} declares no calibration; ignoring --kiosk-calibrate`);
    }
    return;
  }
  if (!config.forceCalibrate) {
    if (config.manifest.calibration.required !== true) return;
    if (await isCalibrated(server, appSlug)) return;
  }

  console.log(`[gosai-kiosk] running the calibration of ${appSlug}`);
  const result = await calibration.run({ appSlug, displayId });
  if (result.ok) console.log('[gosai-kiosk] calibration saved');
  else console.error(`[gosai-kiosk] calibration did not complete: ${result.error}`);
}

async function isCalibrated(server: ServerClient, appSlug: string): Promise<boolean> {
  try {
    return (await server.request('calibration:get', { appSlug })).calibrated;
  } catch (err) {
    console.error(`[gosai-kiosk] could not read the calibration of ${appSlug}: ${String(err)}`);
    return false;
  }
}

async function startExperienceWithRetry(
  server: ServerClient,
  appSlug: string,
  experienceSlug: string,
  attempts = 3,
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    try {
      await server.ready(10_000);
      await server.request('experience:start', { appSlug, experienceSlug });
      return true;
    } catch (err) {
      console.error(`[gosai-kiosk] experience start attempt ${i + 1} failed: ${String(err)}`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}
