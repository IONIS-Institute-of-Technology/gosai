import { app, BrowserWindow } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { registerIpc } from './ipc.js';
import { WindowRegistry } from './windows.js';
import { ServerRunner } from './server-runner.js';

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

const windows = new WindowRegistry({ rootDir: __dirname });
const serverRunner = new ServerRunner();

app.whenReady().then(() => {
  if (serverRunner.shouldAutostart()) {
    serverRunner.start();
  }
  registerIpc({ windows });
  windows.openDashboard();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      windows.openDashboard();
    }
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', async (event) => {
  // Suppress per-window POST /v1/experiences/stop; apps.shutdown() handles all
  // experiences in a single call.
  windows.setShuttingDown();
  windows.closeAllControlWindows();
  windows.closeAllAppHosts();
  if (serverRunner.isRunning()) {
    event.preventDefault();
    await serverRunner.stop().catch(() => undefined);
    app.exit();
  }
});
