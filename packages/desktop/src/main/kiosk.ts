/**
 * Kiosk mode: boot straight into a single app, no dashboard.
 *
 * Activated by (in priority order):
 * 1. `--kiosk <app-dir>` CLI flag or `GOSAI_KIOSK_APP=<app-dir>` env var,
 *    pointing at a built app directory (contains gosai.app.json + dist/).
 * 2. A `kiosk.json` file in the packaged app's resources directory - this is
 *    how per-app kiosk bundles built by `bun run package:kiosk` start.
 *
 * Each kiosk owns an isolated data directory (GOSAI_HOME, defaulting to
 * ~/.gosai-kiosks/<slug>) holding its config, storage, logs, and Electron
 * profile, and starts its own embedded server on an ephemeral port. Several
 * kiosks therefore coexist on one machine without any port coordination.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { app, screen } from 'electron';
import { ServerRunner } from './server-runner.js';
import { ensurePythonRuntime } from './python-bootstrap.js';
import { SplashWindow } from './splash.js';
import {
  DEFAULT_CALIBRATION_STATUS_KEY,
  hasCalibrationRunner,
  isCalibrated,
  runKioskCalibration,
  type CalibrationSchema,
} from './kiosk-calibration.js';
import type { WindowRegistry } from './windows.js';

interface AppManifest {
  slug: string;
  name?: string;
  default?: string;
  calibration?: CalibrationSchema;
  experiences: Array<{ slug: string; entry: string }>;
}

export interface KioskConfig {
  /** Directory of the app to run (contains gosai.app.json). */
  readonly appDir: string;
  readonly manifest: AppManifest;
  readonly experienceSlug: string;
  readonly fullscreen: boolean;
  /** Index into screen.getAllDisplays(); primary display when omitted. */
  readonly displayIndex?: number;
  /** Isolated data directory for this kiosk instance. */
  readonly homeDir: string;
  /** Optional Python dependency extras (e.g. ["speech"]). */
  readonly pythonExtras: string[];
  /** Force the calibration wizard on this launch even if already calibrated. */
  readonly forceCalibrate: boolean;
}

interface KioskFileConfig {
  appSlug?: string;
  experienceSlug?: string;
  fullscreen?: boolean;
  displayIndex?: number;
  pythonExtras?: string[];
}

/**
 * Detects kiosk mode. Must run before `app.whenReady()` so the Electron
 * profile directory can be redirected per instance.
 */
export function resolveKioskConfig(): KioskConfig | null {
  const fromCli = readCliOrEnvConfig();
  if (fromCli) return fromCli;
  return readPackagedConfig();
}

function readCliOrEnvConfig(): KioskConfig | null {
  const argv = process.argv;
  const flagIdx = argv.indexOf('--kiosk');
  const appDirArg =
    flagIdx !== -1 && argv[flagIdx + 1] ? argv[flagIdx + 1] : process.env.GOSAI_KIOSK_APP;
  if (!appDirArg) return null;

  const appDir = resolve(appDirArg);
  const manifest = readManifest(appDir);

  // Flags are prefixed with "kiosk-" to avoid clashing with Chromium
  // switches (e.g. --display selects an X server on Linux).
  const displayArg = argValue(argv, '--kiosk-display') ?? process.env.GOSAI_KIOSK_DISPLAY;
  const windowed = argv.includes('--kiosk-windowed') || process.env.GOSAI_KIOSK_WINDOWED === '1';
  const experience =
    argValue(argv, '--kiosk-experience') ?? process.env.GOSAI_KIOSK_EXPERIENCE ?? undefined;
  const extrasArg =
    argValue(argv, '--kiosk-python-extras') ?? process.env.GOSAI_KIOSK_PYTHON_EXTRAS;

  return buildConfig(appDir, manifest, {
    experienceSlug: experience,
    fullscreen: !windowed,
    displayIndex: displayArg !== undefined ? Number.parseInt(displayArg, 10) : undefined,
    ...(extrasArg ? { pythonExtras: parseExtras(extrasArg) } : {}),
  });
}

function readPackagedConfig(): KioskConfig | null {
  if (!app.isPackaged) return null;
  const configPath = join(process.resourcesPath, 'kiosk.json');
  if (!existsSync(configPath)) return null;

  const file = JSON.parse(readFileSync(configPath, 'utf8')) as KioskFileConfig;
  if (!file.appSlug) throw new Error('kiosk.json is missing "appSlug"');

  const appDir = join(process.resourcesPath, 'apps', file.appSlug);
  const manifest = readManifest(appDir);

  // Environment variables override the values baked in at packaging time so
  // a deployed kiosk can be re-pointed (display, experience, ...) without
  // rebuilding the bundle.
  const env = process.env;
  const overrides: KioskFileConfig = {
    ...file,
    ...(env.GOSAI_KIOSK_EXPERIENCE ? { experienceSlug: env.GOSAI_KIOSK_EXPERIENCE } : {}),
    ...(env.GOSAI_KIOSK_DISPLAY !== undefined
      ? { displayIndex: Number.parseInt(env.GOSAI_KIOSK_DISPLAY, 10) }
      : {}),
    ...(env.GOSAI_KIOSK_WINDOWED === '1' ? { fullscreen: false } : {}),
    ...(env.GOSAI_KIOSK_PYTHON_EXTRAS
      ? { pythonExtras: parseExtras(env.GOSAI_KIOSK_PYTHON_EXTRAS) }
      : {}),
  };
  return buildConfig(appDir, manifest, overrides);
}

function buildConfig(
  appDir: string,
  manifest: AppManifest,
  overrides: KioskFileConfig,
): KioskConfig {
  const experienceSlug =
    overrides.experienceSlug ?? manifest.default ?? manifest.experiences[0]?.slug;
  if (!experienceSlug) {
    throw new Error(`App ${manifest.slug} declares no experiences`);
  }
  const homeDir = process.env.GOSAI_HOME
    ? resolve(process.env.GOSAI_HOME)
    : join(homedir(), '.gosai-kiosks', manifest.slug);
  return {
    appDir,
    manifest,
    experienceSlug,
    fullscreen: overrides.fullscreen !== false,
    ...(overrides.displayIndex !== undefined && Number.isFinite(overrides.displayIndex)
      ? { displayIndex: overrides.displayIndex }
      : {}),
    homeDir,
    pythonExtras: overrides.pythonExtras ?? [],
    forceCalibrate:
      process.argv.includes('--kiosk-calibrate') || process.env.GOSAI_KIOSK_CALIBRATE === '1',
  };
}

function parseExtras(value: string): string[] {
  return value
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean);
}

function readManifest(appDir: string): AppManifest {
  const manifestPath = join(appDir, 'gosai.app.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`Not a GOSAI app: ${manifestPath} not found`);
  }
  return JSON.parse(readFileSync(manifestPath, 'utf8')) as AppManifest;
}

function argValue(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  return idx !== -1 ? argv[idx + 1] : undefined;
}

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
}

/**
 * Creates the kiosk's server runner. The server gets its own home directory
 * and an ephemeral port (port 0), and only sees this kiosk's app.
 */
function createKioskServerRunner(config: KioskConfig, pythonDir: string | null): ServerRunner {
  const fallbackPythonDir = app.isPackaged ? join(process.resourcesPath, 'python') : undefined;
  const resolvedPythonDir = pythonDir ?? fallbackPythonDir;
  return new ServerRunner({
    port: 0,
    homeDir: config.homeDir,
    builtinAppsDir: prepareAppsDir(config),
    ...(resolvedPythonDir ? { pythonDir: resolvedPythonDir } : {}),
  });
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
  symlinkSync(target, link, 'dir');
}

/**
 * Boots the kiosk: materialise the Python runtime (first launch only), start
 * the embedded server, start the experience, open the window. Returns the
 * server runner so the caller can stop it on quit.
 */
export async function runKiosk(options: RunKioskOptions): Promise<ServerRunner> {
  const { config, windows } = options;

  // First-run Python installation with a visible status window - a kiosk
  // machine should never sit on a black screen for minutes.
  const splash = new SplashWindow();
  let pythonDir: string | null = null;
  try {
    pythonDir = await ensurePythonRuntime({
      extras: config.pythonExtras,
      onStatus: (message) => {
        splash.show();
        splash.setStatus(message);
      },
    });
  } catch (err) {
    // Keep going: JS-only apps still work, and the app-host window makes the
    // failure visible instead of exiting to a black screen.
    console.error(`[gosai-kiosk] python runtime setup failed: ${String(err)}`);
  }

  const serverRunner = createKioskServerRunner(config, pythonDir);
  serverRunner.start();
  if (!serverRunner.isRunning()) {
    splash.close();
    throw new Error('kiosk mode requires the embedded server, but none could be started');
  }
  const address = await serverRunner.waitForReady();
  splash.close();
  windows.setServerAddress(address);
  const baseUrl = `http://${address.host}:${address.port}`;

  const appSlug = config.manifest.slug;
  const displays = screen.getAllDisplays();
  const display =
    config.displayIndex !== undefined
      ? (displays[config.displayIndex] ?? screen.getPrimaryDisplay())
      : screen.getPrimaryDisplay();

  await maybeCalibrate(config, windows, baseUrl, display.id);

  const started = await startExperienceWithRetry(baseUrl, appSlug, config.experienceSlug);
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
      `running on ${baseUrl}, home=${config.homeDir}`,
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
  baseUrl: string,
  displayId: number,
): Promise<void> {
  const schema = config.manifest.calibration;
  const required = schema?.required === true;
  if (!required && !config.forceCalibrate) return;

  const appSlug = config.manifest.slug;
  const statusKey = schema?.statusKey ?? DEFAULT_CALIBRATION_STATUS_KEY;
  if (!config.forceCalibrate && (await isCalibrated(baseUrl, appSlug, statusKey))) return;

  if (!(await hasCalibrationRunner(baseUrl))) {
    console.error(
      `[gosai-kiosk] ${appSlug} needs calibration but the calibration runner app is not ` +
        'bundled; repackage with a manifest that declares "calibration"',
    );
    return;
  }

  console.log(`[gosai-kiosk] running calibration wizard for ${appSlug}`);
  try {
    await runKioskCalibration({ baseUrl, windows, targetAppSlug: appSlug, displayId });
    console.log('[gosai-kiosk] calibration wizard closed');
  } catch (err) {
    console.error(`[gosai-kiosk] calibration failed: ${String(err)}`);
  }
}

async function startExperienceWithRetry(
  baseUrl: string,
  appSlug: string,
  experienceSlug: string,
  attempts = 3,
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`${baseUrl}/v1/experiences/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ appSlug, experienceSlug }),
      });
      if (res.ok) return true;
      console.error(`[gosai-kiosk] experience start failed (${res.status}): ${await res.text()}`);
    } catch (err) {
      console.error(`[gosai-kiosk] experience start attempt ${i + 1} failed: ${String(err)}`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}
