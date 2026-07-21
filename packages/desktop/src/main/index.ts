import { app, BrowserWindow } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { registerIpc } from './ipc.js';
import { WindowRegistry } from './windows.js';
import { ServerRunner, shouldAutostartServer } from './server-runner.js';
import { applyKioskPaths, resolveKioskConfig, runKiosk } from './kiosk.js';
import { ensurePythonRuntime } from './python-bootstrap.js';
import { SplashWindow } from './splash.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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

const kioskConfig = resolveKioskConfig();
if (kioskConfig) applyKioskPaths(kioskConfig);

const windows = new WindowRegistry({ rootDir: __dirname });
let serverRunner: ServerRunner | null = null;

app.whenReady().then(async () => {
  registerIpc({ windows });

  if (kioskConfig) {
    try {
      serverRunner = await runKiosk({ config: kioskConfig, windows });
    } catch (err) {
      console.error(`[gosai-kiosk] failed to start: ${String(err)}`);
      app.exit(1);
    }
    return;
  }

  if (shouldAutostartServer()) {
    serverRunner = await startEmbeddedServer();
  }
  windows.openDashboard();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      windows.openDashboard();
    }
  });
});

/**
 * Regular desktop mode with the embedded server: materialise the Python
 * runtime first (first launch only, with a status window), then start the
 * server and point the windows at it.
 */
async function startEmbeddedServer(): Promise<ServerRunner> {
  const splash = new SplashWindow();
  let pythonDir: string | null = null;
  try {
    pythonDir = await ensurePythonRuntime({
      onStatus: (message) => {
        splash.show();
        splash.setStatus(message);
      },
    });
  } catch (err) {
    console.error(`[gosai-desktop] python runtime setup failed: ${String(err)}`);
  }

  const runner = new ServerRunner(pythonDir ? { pythonDir } : {});
  runner.start();
  if (runner.isRunning()) {
    try {
      const address = await runner.waitForReady();
      windows.setServerAddress(address);
    } catch (err) {
      // The dashboard still opens and shows its disconnected state.
      console.error(`[gosai-desktop] embedded server did not become ready: ${String(err)}`);
    }
  }
  splash.close();
  return runner;
}

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', async (event) => {
  // Suppress per-window POST /v1/experiences/stop; apps.shutdown() handles all
  // experiences in a single call.
  windows.setShuttingDown();
  windows.closeAllControlWindows();
  windows.closeAllAppHosts();
  if (serverRunner?.isRunning()) {
    event.preventDefault();
    await serverRunner.stop().catch(() => undefined);
    app.exit();
  }
});
