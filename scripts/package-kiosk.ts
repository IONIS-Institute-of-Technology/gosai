#!/usr/bin/env bun
/**
 * Builds a self-contained kiosk bundle for a single GOSAI app.
 *
 * Usage:
 *   bun run package:kiosk -- <app-dir> [options]
 *
 * Options:
 *   --target <name>       linux-x64, mac-arm64 or win-x64 (default: this machine)
 *   --macos               Same as --target mac-arm64
 *   --experience <slug>   Experience to boot (default: the app's default)
 *   --display <index>     Display index to open on (default: primary)
 *   --python-extras <l>   Comma-separated Python extras to install on first
 *                         run (e.g. speech,realsense). The CV stack is part
 *                         of the base dependencies and always included.
 *   --windowed            Open in a window instead of fullscreen kiosk
 *   --skip-build          Reuse the workspace and app builds
 *
 * The output (packages/desktop/release/kiosk/<slug>/) is a DMG, AppImage or
 * installer embedding Electron, the compiled server, uv, the Python tree, and
 * only this app, plus a kiosk.json marker that makes the shell boot straight
 * into it. On first launch the kiosk creates its own data directory under
 * ~/.gosai-kiosks/<slug> and picks a free port automatically.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { parseDisplayIndex, parseExtras } from '../packages/desktop/src/main/launch-args.js';
import { prepareBundle } from './prepare-bundle.js';
import { hostTarget, parseTarget, TARGETS } from './targets.js';

const repoRoot = resolve(import.meta.dir, '..');
const desktopDir = join(repoRoot, 'packages', 'desktop');

const USAGE = 'usage: bun run package:kiosk -- <app-dir> [--target <name>] [--skip-build]';

interface Manifest {
  slug: string;
  name?: string;
  version?: string;
  default?: string;
  calibration?: { required?: boolean; entry?: string };
  experiences: Array<{ slug: string; entry: string }>;
}

function fail(message: string): never {
  console.error(`[package-kiosk] ${message}`);
  process.exit(1);
}

async function run(cmd: string[], cwd: string, env?: Record<string, string>): Promise<void> {
  console.log(`[package-kiosk] $ ${cmd.join(' ')}`);
  const proc = Bun.spawn({
    cmd,
    cwd,
    env: { ...process.env, ...env },
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const code = await proc.exited;
  if (code !== 0) fail(`command failed with exit code ${code}: ${cmd.join(' ')}`);
}

// --- Parse arguments ---------------------------------------------------------

let parsed: ReturnType<typeof parseCliArgs>;
try {
  parsed = parseCliArgs();
} catch (err) {
  fail(`${err instanceof Error ? err.message : String(err)}\n${USAGE}`);
}

function parseCliArgs() {
  const { values, positionals } = parseArgs({
    options: {
      target: { type: 'string' },
      macos: { type: 'boolean' },
      experience: { type: 'string' },
      display: { type: 'string' },
      'python-extras': { type: 'string' },
      windowed: { type: 'boolean' },
      'skip-build': { type: 'boolean' },
    },
    allowPositionals: true,
  });
  if (positionals.length !== 1) throw new Error('expected exactly one <app-dir>');
  if (values.macos && values.target && values.target !== 'mac-arm64') {
    throw new Error('--macos conflicts with --target');
  }
  return {
    appDir: resolve(positionals[0]!),
    target: values.macos ? 'mac-arm64' : values.target ? parseTarget(values.target) : hostTarget(),
    experience: values.experience,
    displayIndex:
      values.display !== undefined ? parseDisplayIndex(values.display, '--display') : undefined,
    pythonExtras: values['python-extras'] ? parseExtras(values['python-extras']) : [],
    windowed: values.windowed === true,
    skipBuild: values['skip-build'] === true,
  } as const;
}

const { appDir, target, experience, displayIndex, pythonExtras, windowed, skipBuild } = parsed;
const manifestPath = join(appDir, 'gosai.app.json');
if (!existsSync(manifestPath)) fail(`not a GOSAI app: ${manifestPath} not found`);
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
if (!manifest.slug) fail('manifest has no "slug"');
if (experience && !manifest.experiences.some((e) => e.slug === experience)) {
  fail(`experience "${experience}" not declared in ${manifest.slug}`);
}

// --- Build everything --------------------------------------------------------

if (!skipBuild) {
  // shared, server, sdk, desktop (electron-vite).
  await run(['bun', 'run', 'build'], repoRoot);

  // Build the app itself when it knows how (workspace apps and any app
  // directory with a build script). Pre-built external apps just need dist/.
  const appPkgPath = join(appDir, 'package.json');
  if (existsSync(appPkgPath)) {
    const appPkg = JSON.parse(readFileSync(appPkgPath, 'utf8')) as {
      scripts?: Record<string, string>;
    };
    if (appPkg.scripts?.build) {
      await run(['bun', 'run', 'build'], appDir);
    }
  }
}

// The server for the target, uv and python-runtime.json. Always rebuilt so
// the bundle never ships a stale server or Python hash.
try {
  await prepareBundle(target);
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}

for (const exp of manifest.experiences) {
  const entryPath = join(appDir, exp.entry);
  if (!existsSync(entryPath)) {
    fail(`experience entry missing: ${entryPath} - build the app first`);
  }
}
if (manifest.calibration?.entry && !existsSync(join(appDir, manifest.calibration.entry))) {
  fail(`calibration entry missing: ${join(appDir, manifest.calibration.entry)}`);
}

// Apps that declare calibration also need the built-in calibration runner in
// the bundle; the kiosk shell launches it on first boot (and on demand via
// GOSAI_KIOSK_CALIBRATE=1) to write the profile into the app's storage.
let calibrationAppDir: string | null = null;
if (manifest.calibration) {
  calibrationAppDir = join(repoRoot, 'apps', 'calibration');
  if (!existsSync(join(calibrationAppDir, 'gosai.app.json'))) {
    fail(`app declares calibration but the runner app is missing at ${calibrationAppDir}`);
  }
  if (!skipBuild) {
    await run(['bun', 'run', 'build'], calibrationAppDir);
  }
  if (!existsSync(join(calibrationAppDir, 'dist', 'calibrate.js'))) {
    fail('calibration runner is not built (apps/calibration/dist/calibrate.js missing)');
  }
}

// --- Stage the single app + kiosk marker --------------------------------------

const stagingDir = join(desktopDir, 'release', 'kiosk-staging', manifest.slug);
rmSync(stagingDir, { recursive: true, force: true });
mkdirSync(join(stagingDir, 'apps'), { recursive: true });

// Directories that must never ship with a package: build/dev artifacts, plus
// the server's per-install app state (`_data` = storage, `_config` = device
// assignments). State belongs to each machine — a kiosk creates its own on
// first boot; bundling the dev computer's would override the kiosk's config.
const STAGE_EXCLUDES = new Set(['node_modules', '.git', '_data', '_config']);

const stageApp = (from: string, slug: string): void => {
  cpSync(from, join(stagingDir, 'apps', slug), {
    recursive: true,
    dereference: true,
    filter: (src) => !STAGE_EXCLUDES.has(basename(src)),
  });
};
stageApp(appDir, manifest.slug);
if (calibrationAppDir) stageApp(calibrationAppDir, 'calibration');

writeFileSync(
  join(stagingDir, 'kiosk.json'),
  JSON.stringify(
    {
      appSlug: manifest.slug,
      ...(experience ? { experienceSlug: experience } : {}),
      ...(displayIndex !== undefined ? { displayIndex } : {}),
      ...(windowed ? { fullscreen: false } : {}),
      ...(pythonExtras.length > 0 ? { pythonExtras } : {}),
    },
    null,
    2,
  ),
);

// --- Run electron-builder ------------------------------------------------------

const electronBuilder = join(
  repoRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'electron-builder.exe' : 'electron-builder',
);
if (!existsSync(electronBuilder)) fail('electron-builder not found; run `bun install`');

await run(
  [
    electronBuilder,
    TARGETS[target].builderFlag,
    '--config',
    'electron-builder.kiosk.config.cjs',
    '--publish',
    'never',
  ],
  desktopDir,
  {
    GOSAI_KIOSK_STAGING: stagingDir,
    GOSAI_KIOSK_SLUG: manifest.slug,
    GOSAI_KIOSK_NAME: manifest.name ?? manifest.slug,
    ...(manifest.version ? { GOSAI_KIOSK_VERSION: manifest.version } : {}),
  },
);

console.log(
  `[package-kiosk] done - artifacts in ${join(desktopDir, 'release', 'kiosk', manifest.slug)}`,
);
