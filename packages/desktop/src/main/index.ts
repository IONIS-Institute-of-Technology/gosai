import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { app, dialog } from 'electron';
import { generateDashboardToken } from '@gosai/shared/auth';
import { bootRuntime, showBootFailure, showBootWarnings, type BootMode } from './boot.js';
import { CalibrationOrchestrator } from './calibration.js';
import { ExperienceWindows } from './experience-windows.js';
import { registerIpc } from './ipc.js';
import { applyKioskPaths, kioskDisplay, runKiosk } from './kiosk.js';
import { resolveKioskConfig, type KioskConfig } from './kiosk-config.js';
import { parseLaunchArgs } from './launch-args.js';
import { installWebContentsGuards } from './security.js';
import { checkServerToken } from './server-auth.js';
import { shouldAutostartServer, type ServerRunner } from './server-runner.js';
import { SplashWindow } from './splash.js';
import { WindowRegistry } from './windows.js';

function configureLinuxWindowingBackend(): void {
  if (process.platform !== 'linux') return;

  // Allow explicit opt-in to native Wayland or auto-detection.
  const override = process.env.GOSAI_OZONE_PLATFORM;
  if (override === 'wayland' || override === 'auto') return;

  // Force XWayland for reliable window positioning and fullscreen display
  // targeting on multi-monitor setups. Appended unconditionally because
  // Electron may have already resolved ozone-platform-hint=auto to
  // ozone-platform=wayland before JS runs; Chromium uses the last value.
  app.commandLine.appendSwitch('ozone-platform', 'x11');
}

configureLinuxWindowingBackend();

// Bad kiosk settings are reported once the app is ready to show them.
let kioskConfig: KioskConfig | null = null;
let configError: unknown = null;
try {
  kioskConfig = resolveKioskConfig({
    args: parseLaunchArgs(process.argv.slice(1)),
    env: process.env,
    resourcesPath: app.isPackaged ? process.resourcesPath : null,
    homedir: homedir(),
  });
} catch (err) {
  configError = err;
}
const mode: BootMode = kioskConfig || (configError && looksLikeKiosk()) ? 'kiosk' : 'desktop';
if (kioskConfig) applyKioskPaths(kioskConfig);

// The lock is per Electron profile, and each kiosk has its own, so several
// kiosks still run side by side. Takes the lock after applyKioskPaths. A
// launch with bad kiosk settings skips it: it would take the default
// profile's lock and exit 0 behind a running desktop instead of reporting
// the error and exiting 1.
if (configError || app.requestSingleInstanceLock()) {
  main();
} else {
  console.log('[gosai] another GOSAI instance already runs with this data directory; exiting');
  app.quit();
}

function main(): void {
  // A new token at each launch. GOSAI_DASHBOARD_TOKEN lets `bun run dev`
  // share one token between a separately started server and this app.
  const dashboardToken = process.env.GOSAI_DASHBOARD_TOKEN || generateDashboardToken();
  delete process.env.GOSAI_DASHBOARD_TOKEN;

  const windows = new WindowRegistry({ rootDir: import.meta.dirname, dashboardToken });
  // A kiosk opens its windows on the display its settings name.
  const kiosk = kioskConfig;
  const experienceWindows = new ExperienceWindows(
    windows,
    kiosk ? { resolveDisplay: () => kioskDisplay(kiosk) } : {},
  );
  let exitCode = 0;
  const calibration = new CalibrationOrchestrator(windows, experienceWindows);
  let serverRunner: ServerRunner | null = null;
  let booted = false;

  installWebContentsGuards((contents) => windows.isAppWindow(contents));

  app.on('second-instance', () => {
    if (mode === 'desktop' && booted) windows.openDashboard();
  });

  app.on('render-process-gone', (_event, _contents, details) => {
    if (mode !== 'kiosk' || details.reason === 'clean-exit') return;
    console.error(`[gosai-kiosk] a renderer is gone (${details.reason}); exiting`);
    app.exit(1);
  });

  app.whenReady().then(async () => {
    registerIpc({ windows, calibration });
    // Opens on its first status message, so a dev launch without it stays quiet.
    const splash = new SplashWindow();

    if (configError) {
      await showBootFailure(mode, splash, configError);
      app.exit(1);
      return;
    }

    if (kioskConfig) {
      try {
        serverRunner = await runKiosk({
          config: kioskConfig,
          windows,
          calibration,
          experienceWindows,
          dashboardToken,
          splash,
          quit: (code) => {
            exitCode = code;
            app.quit();
          },
        });
        booted = true;
      } catch (err) {
        await showBootFailure(mode, splash, err);
        app.exit(1);
      }
      return;
    }

    let warnings: readonly string[] = [];
    if (shouldAutostartServer()) {
      try {
        const runtime = await bootRuntime({ dashboardToken, splash });
        serverRunner = runtime.runner;
        warnings = runtime.warnings;
        windows.setServerAddress(runtime.address);
        runtime.runner.onUnexpectedExit((description) => {
          void dialog.showMessageBox({
            type: 'error',
            title: 'GOSAI',
            message: 'The GOSAI server stopped',
            detail: `The server ${description}. Restart GOSAI to reconnect.`,
          });
        });
      } catch (err) {
        await showBootFailure(mode, splash, err);
        app.exit(1);
        return;
      }
    } else {
      // `bun run dev` starts the server itself, on GOSAI_PORT or 7777.
      const port = Number.parseInt(process.env.GOSAI_PORT ?? '', 10);
      windows.setServerAddress({
        host: '127.0.0.1',
        port: Number.isSafeInteger(port) ? port : 7777,
      });
      void checkServerToken(windows.serverBaseUrl, dashboardToken);
    }

    // Main opens and closes the windows of every experience from now on.
    experienceWindows.start();
    windows.openDashboard();
    splash.close();
    booted = true;
    void showBootWarnings(mode, splash, warnings);
  });

  app.on('window-all-closed', () => {
    // Boot and kiosks pass through moments without windows (splash, then
    // calibration, then app, and between experiences). Kiosks quit by the
    // rules in kiosk-lifecycle.ts.
    if (mode === 'desktop' && booted) app.quit();
  });

  let quitting = false;
  app.on('before-quit', (event) => {
    if (quitting) return;
    quitting = true;
    event.preventDefault();
    // Don't send experience:stop for each closing window; the server's
    // shutdown stops every experience at once.
    windows.setShuttingDown();
    experienceWindows.stop();
    void (async () => {
      // Let running experiences stop before the server goes away.
      await Promise.all([windows.closeAllControlWindows(), windows.closeAllAppHosts()]);
      if (serverRunner?.isRunning()) await serverRunner.stop().catch(() => undefined);
      app.exit(exitCode);
    })();
  });
}

/** Whether this launch meant to be a kiosk, to pick how a config error is shown. */
function looksLikeKiosk(): boolean {
  return (
    process.argv.some((arg) => arg.startsWith('--kiosk')) ||
    !!process.env.GOSAI_KIOSK_APP ||
    (app.isPackaged && existsSync(join(process.resourcesPath, 'kiosk.json')))
  );
}
