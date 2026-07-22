#!/usr/bin/env bun
/**
 * Builds a self-contained kiosk bundle for a single GOSAI app.
 *
 * Usage:
 *   bun run package:kiosk -- <app-dir> [options]
 *
 * Options:
 *   --macos               Build a macOS DMG (default: Linux AppImage)
 *   --experience <slug>   Experience to boot (default: the app's default)
 *   --display <index>     Display index to open on (default: primary)
 *   --python-extras <l>   Comma-separated Python extras to install on first
 *                         run (e.g. speech,realsense). The CV stack is part
 *                         of the base dependencies and always included.
 *   --windowed            Open in a window instead of fullscreen kiosk
 *   --skip-build          Reuse existing build artifacts
 *
 * The output (packages/desktop/release/kiosk/<slug>/) is a DMG / AppImage
 * embedding Electron, the compiled server, the Python tree, and only this
 * app, plus a kiosk.json marker that makes the shell boot straight into it.
 * On first launch the kiosk creates its own data directory under
 * ~/.gosai-kiosks/<slug> and picks a free port automatically.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fetchUv } from './fetch-uv.ts';

const repoRoot = resolve(import.meta.dir, '..');
const desktopDir = join(repoRoot, 'packages', 'desktop');

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

const argv = process.argv.slice(2);
const positional: string[] = [];
let platform: 'mac' | 'linux' = 'linux';
let experience: string | undefined;
let displayIndex: number | undefined;
let pythonExtras: string[] = [];
let windowed = false;
let skipBuild = false;

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]!;
  switch (arg) {
    case '--macos':
    case '--mac':
      platform = 'mac';
      break;
    case '--linux':
      platform = 'linux';
      break;
    case '--experience':
      experience = argv[++i];
      break;
    case '--display':
      displayIndex = Number.parseInt(argv[++i] ?? '', 10);
      break;
    case '--python-extras':
      pythonExtras = (argv[++i] ?? '')
        .split(',')
        .map((e) => e.trim())
        .filter(Boolean);
      break;
    case '--windowed':
      windowed = true;
      break;
    case '--skip-build':
      skipBuild = true;
      break;
    default:
      if (arg.startsWith('-')) fail(`unknown option: ${arg}`);
      positional.push(arg);
  }
}

const appDirArg = positional[0];
if (!appDirArg) fail('usage: bun run package:kiosk -- <app-dir> [--macos] [--skip-build]');
const appDir = resolve(appDirArg);
const manifestPath = join(appDir, 'gosai.app.json');
if (!existsSync(manifestPath)) fail(`not a GOSAI app: ${manifestPath} not found`);
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
if (!manifest.slug) fail('manifest has no "slug"');
if (experience && !manifest.experiences.some((e) => e.slug === experience)) {
  fail(`experience "${experience}" not declared in ${manifest.slug}`);
}

// --- Build everything --------------------------------------------------------

if (!skipBuild) {
  // shared, server, sdk, desktop (electron-vite) - same chain as package:mac.
  await run(['bun', 'run', 'build'], repoRoot);

  // Cross-compile the server binary for the *target* platform (bun supports
  // cross-compilation), so e.g. a Linux AppImage built on an Apple Silicon
  // Mac ships a Linux x64 server instead of a host-arch binary.
  const bunTarget =
    platform === 'linux'
      ? 'bun-linux-x64'
      : `bun-darwin-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;
  mkdirSync(join(desktopDir, 'release', 'server'), { recursive: true });
  await run(
    [
      'bun',
      'build',
      'packages/server/src/index.ts',
      '--compile',
      `--target=${bunTarget}`,
      '--outfile',
      join(desktopDir, 'release', 'server', 'gosai-server'),
    ],
    repoRoot,
  );

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
      ...(displayIndex !== undefined && Number.isFinite(displayIndex) ? { displayIndex } : {}),
      ...(windowed ? { fullscreen: false } : {}),
      ...(pythonExtras.length > 0 ? { pythonExtras } : {}),
    },
    null,
    2,
  ),
);

// --- Bundle uv so the target machine can build the Python venv on first run ---

const uvDir = join(desktopDir, 'release', 'uv', platform);
await fetchUv(platform, uvDir);

// --- Run electron-builder ------------------------------------------------------

const electronBuilder = join(repoRoot, 'node_modules', '.bin', 'electron-builder');
if (!existsSync(electronBuilder)) fail('electron-builder not found; run `bun install`');

await run(
  [
    electronBuilder,
    platform === 'mac' ? '--mac' : '--linux',
    '--config',
    'electron-builder.kiosk.config.cjs',
  ],
  desktopDir,
  {
    GOSAI_KIOSK_STAGING: stagingDir,
    GOSAI_KIOSK_SLUG: manifest.slug,
    GOSAI_KIOSK_NAME: manifest.name ?? manifest.slug,
    GOSAI_KIOSK_UV_DIR: uvDir,
    ...(manifest.version ? { GOSAI_KIOSK_VERSION: manifest.version } : {}),
  },
);

console.log(
  `[package-kiosk] done - artifacts in ${join(desktopDir, 'release', 'kiosk', manifest.slug)}`,
);
