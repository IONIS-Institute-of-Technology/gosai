/**
 * Boot sequence shared by the desktop app and kiosks: splash, Python
 * runtime, server start, wait for the server to be ready.
 */

import { join } from 'node:path';
import { app, dialog } from 'electron';
import { ensurePythonRuntime } from './python-bootstrap.js';
import { ServerRunner, type ServerAddress } from './server-runner.js';
import type { SplashWindow } from './splash.js';

export type BootMode = 'desktop' | 'kiosk';

/** How long a kiosk shows a boot failure before exiting, and a warning before continuing. */
const KIOSK_ERROR_MS = 15_000;
const KIOSK_WARNING_MS = 8_000;

export interface BootOptions {
  readonly dashboardToken: string;
  readonly splash: SplashWindow;
  readonly pythonExtras?: readonly string[];
  readonly homeDir?: string;
  readonly builtinAppsDir?: string;
}

export interface BootedRuntime {
  readonly runner: ServerRunner;
  readonly address: ServerAddress;
  /** Problems boot continued past. Show them to the user. */
  readonly warnings: readonly string[];
}

/** Throws when the server can't start. */
export async function bootRuntime(options: BootOptions): Promise<BootedRuntime> {
  const { splash } = options;
  splash.setStatus('Starting…');
  const warnings: string[] = [];
  const python = await preparePython(options, warnings);

  splash.setStatus('Starting the GOSAI server…');
  // From source the server finds the repository's apps/ itself.
  const builtinAppsDir =
    options.builtinAppsDir ?? (app.isPackaged ? join(process.resourcesPath, 'apps') : null);
  const runner = new ServerRunner({
    dashboardToken: options.dashboardToken,
    ...(python.kind === 'ready' && python.pythonDir ? { pythonDir: python.pythonDir } : {}),
    ...(python.kind === 'failed' ? { pythonSetupError: python.error } : {}),
    ...(options.homeDir ? { homeDir: options.homeDir } : {}),
    ...(builtinAppsDir ? { builtinAppsDir } : {}),
  });
  try {
    runner.start();
    const address = await runner.waitForReady();
    return { runner, address, warnings };
  } catch (err) {
    await runner.stop();
    throw new Error(`The GOSAI server could not start: ${errorMessage(err)}`, { cause: err });
  }
}

/**
 * The Python runtime to hand the server. `pythonDir` is null when the server
 * finds its own: from source, or when GOSAI_PYTHON or GOSAI_PYTHON_DIR is set.
 */
type PythonSetup =
  | { readonly kind: 'ready'; readonly pythonDir: string | null }
  | { readonly kind: 'failed'; readonly error: string };

/**
 * Python problems don't stop the boot: apps without Python drivers still
 * work. The server gets the reason and fails Python driver calls with it.
 */
async function preparePython(options: BootOptions, warnings: string[]): Promise<PythonSetup> {
  // The server reads these itself.
  if (process.env.GOSAI_PYTHON === '0' || process.env.GOSAI_PYTHON_DIR) {
    return { kind: 'ready', pythonDir: null };
  }
  try {
    const pythonDir = await ensurePythonRuntime({
      extras: options.pythonExtras ?? [],
      onStatus: (message) => options.splash.setStatus(message),
    });
    return { kind: 'ready', pythonDir };
  } catch (err) {
    const error = errorMessage(err);
    console.error(`[gosai] Python runtime setup failed: ${error}`);
    warnings.push(
      `Python drivers are unavailable because the Python runtime could not be installed: ${error}`,
    );
    return { kind: 'failed', error };
  }
}

/**
 * Desktop: an error dialog. Kiosk: the message stays on the splash for a
 * while, since an unattended machine has nobody to close a dialog.
 */
export async function showBootFailure(
  mode: BootMode,
  splash: SplashWindow,
  error: unknown,
): Promise<void> {
  const message = errorMessage(error);
  console.error(`[gosai] boot failed: ${message}`);
  if (mode === 'kiosk') {
    await showKioskError(splash, 'GOSAI could not start', message);
    return;
  }
  splash.close();
  await dialog.showMessageBox({
    type: 'error',
    title: 'GOSAI',
    message: 'GOSAI could not start',
    detail: message,
    buttons: ['Quit'],
  });
}

/** Shows an error a kiosk exits with on the splash, long enough to read it. */
export async function showKioskError(
  splash: SplashWindow,
  title: string,
  message: string,
): Promise<void> {
  splash.showError(title, message);
  await sleep(KIOSK_ERROR_MS);
}

export async function showBootWarnings(
  mode: BootMode,
  splash: SplashWindow,
  warnings: readonly string[],
): Promise<void> {
  if (warnings.length === 0) return;
  for (const warning of warnings) console.warn(`[gosai] ${warning}`);
  const detail = warnings.join('\n\n');
  if (mode === 'kiosk') {
    splash.showWarning('GOSAI started with problems', detail);
    await sleep(KIOSK_WARNING_MS);
    return;
  }
  await dialog.showMessageBox({
    type: 'warning',
    title: 'GOSAI',
    message: 'GOSAI started with problems',
    detail,
  });
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
