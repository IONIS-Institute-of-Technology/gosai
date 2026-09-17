/**
 * Kiosk mode detection. No Electron import, so tests can drive it.
 *
 * The app comes from, in order:
 * 1. `--kiosk <app-dir>`, then `GOSAI_KIOSK_APP=<app-dir>`: a built app
 *    directory containing gosai.app.json.
 * 2. `kiosk.json` in a packaged app's resources directory, written by
 *    `bun run package:kiosk`.
 *
 * Every other setting takes the command-line flag first, then the
 * environment variable, then the value baked into kiosk.json, so a deployed
 * kiosk can be re-pointed without rebuilding the bundle.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { assertSlug, isValidSlug } from '@gosai/shared/slug';
import type { CalibrationSchema } from './kiosk-calibration.js';
import { parseDisplayIndex, parseExtras, type LaunchArgs } from './launch-args.js';

export interface AppManifest {
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

/** Contents of a packaged kiosk's `kiosk.json`. */
export interface KioskFile {
  appSlug?: string;
  experienceSlug?: string;
  fullscreen?: boolean;
  displayIndex?: number;
  pythonExtras?: string[];
}

export interface KioskConfigSources {
  readonly args: LaunchArgs;
  readonly env: NodeJS.ProcessEnv;
  /** `process.resourcesPath` of a packaged app, null when running from source. */
  readonly resourcesPath: string | null;
  readonly homedir: string;
}

/** The kiosk configuration, or null in regular desktop mode. Throws on bad input. */
export function resolveKioskConfig(sources: KioskConfigSources): KioskConfig | null {
  const { args, env } = sources;
  const appDirArg = args.kiosk ?? (env.GOSAI_KIOSK_APP || undefined);

  let appDir: string;
  let file: KioskFile = {};
  if (appDirArg !== undefined) {
    appDir = resolve(appDirArg);
  } else {
    const { resourcesPath } = sources;
    if (!resourcesPath || !existsSync(join(resourcesPath, 'kiosk.json'))) return null;
    const packaged = readKioskFile(join(resourcesPath, 'kiosk.json'));
    appDir = join(resourcesPath, 'apps', packaged.appSlug);
    file = packaged;
  }

  const manifest = readManifest(appDir);
  const experienceSlug =
    args.kioskExperience ??
    (env.GOSAI_KIOSK_EXPERIENCE || undefined) ??
    file.experienceSlug ??
    manifest.default ??
    manifest.experiences[0]?.slug;
  if (!experienceSlug) throw new Error(`App ${manifest.slug} declares no experiences`);
  if (!manifest.experiences.some((experience) => experience.slug === experienceSlug)) {
    throw new Error(`App ${manifest.slug} has no experience "${experienceSlug}"`);
  }

  const displayIndex =
    args.kioskDisplay ??
    (env.GOSAI_KIOSK_DISPLAY
      ? parseDisplayIndex(env.GOSAI_KIOSK_DISPLAY, 'GOSAI_KIOSK_DISPLAY')
      : file.displayIndex);
  const home = args.kioskHome ?? (env.GOSAI_HOME || undefined);

  return {
    appDir,
    manifest,
    experienceSlug,
    fullscreen: !(
      args.kioskWindowed ||
      env.GOSAI_KIOSK_WINDOWED === '1' ||
      file.fullscreen === false
    ),
    ...(displayIndex !== undefined ? { displayIndex } : {}),
    homeDir: home ? resolve(home) : join(sources.homedir, '.gosai-kiosks', manifest.slug),
    pythonExtras:
      args.kioskPythonExtras ??
      (env.GOSAI_KIOSK_PYTHON_EXTRAS ? parseExtras(env.GOSAI_KIOSK_PYTHON_EXTRAS) : undefined) ??
      file.pythonExtras ??
      [],
    forceCalibrate: args.kioskCalibrate || env.GOSAI_KIOSK_CALIBRATE === '1',
  };
}

function readKioskFile(path: string): KioskFile & { appSlug: string } {
  const file = JSON.parse(readFileSync(path, 'utf8')) as KioskFile;
  if (!isValidSlug(file.appSlug)) {
    throw new Error(`${path} needs a valid "appSlug"`);
  }
  if (
    file.pythonExtras !== undefined &&
    !(Array.isArray(file.pythonExtras) && file.pythonExtras.every((e) => typeof e === 'string'))
  ) {
    throw new Error(`${path}: "pythonExtras" must be an array of strings`);
  }
  if (
    file.displayIndex !== undefined &&
    !(Number.isSafeInteger(file.displayIndex) && file.displayIndex >= 0)
  ) {
    throw new Error(`${path}: "displayIndex" must be a display index (0, 1, ...)`);
  }
  return { ...file, appSlug: file.appSlug };
}

function readManifest(appDir: string): AppManifest {
  const manifestPath = join(appDir, 'gosai.app.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`Not a GOSAI app: ${manifestPath} not found`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as AppManifest;
  if (!Array.isArray(manifest.experiences)) {
    throw new Error(`${manifestPath} needs an "experiences" list`);
  }
  // The slug names directories under the kiosk home that get replaced.
  assertSlug(manifest.slug, `${manifestPath}: slug`);
  return manifest;
}
