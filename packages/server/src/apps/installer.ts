/**
 * App installation. Clones a git repository into a staging directory,
 * validates its manifest, installs JavaScript dependencies, runs the build and,
 * for an app with Python drivers, builds its Python environment with uv (see
 * python-env.ts). The app only moves into the apps directory once every step
 * succeeded; a failed install removes the staging directory and the
 * environment.
 */

import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { AppManifest } from '@gosai/shared';
import { assertSlug } from '@gosai/shared/slug';
import type { ChildLogger } from '../logger/logger.js';
import type { GosaiPaths } from '../paths.js';
import { MANIFEST_FILE, parseManifest, type DiscoveredApp } from './manifest.js';
import {
  appDriversDir,
  appPythonEnvDir,
  buildAppPythonEnv,
  removeAppPythonEnv,
  type PythonToolchain,
} from './python-env.js';
import { runChecked } from './run-step.js';
import { SDK_VERSION, sdkIncompatibility } from './sdk-version.js';

export interface InstallTimeouts {
  readonly gitMs: number;
  readonly jsInstallMs: number;
  readonly buildMs: number;
  readonly pythonMs: number;
}

export interface InstallOptions {
  readonly source: string;
  readonly slugOverride?: string;
  readonly logger: ChildLogger;
  readonly paths: GosaiPaths;
  /** Builds the Python environment of apps with drivers. Such apps are refused without it. */
  readonly python?: PythonToolchain;
  /** Accept `file:` URLs. Only for tests. */
  readonly allowFileSources?: boolean;
  readonly timeouts?: Partial<InstallTimeouts>;
  /** Runs once the manifest is read, before the build. Throw to refuse the app. */
  readonly checkManifest?: (manifest: AppManifest) => void;
  /** SDK version the app's `sdk` range must include. Defaults to the one this server serves. */
  readonly sdkVersion?: string;
}

export interface InstallResult {
  readonly app: DiscoveredApp;
  readonly cloned: boolean;
}

const DEFAULT_TIMEOUTS: InstallTimeouts = {
  gitMs: 5 * 60 * 1000,
  jsInstallMs: 10 * 60 * 1000,
  buildMs: 10 * 60 * 1000,
  pythonMs: 15 * 60 * 1000,
};

/** `user@host:path`, git's scp-like ssh syntax. */
const SCP_LIKE_SOURCE = /^[A-Za-z0-9._~-]+@[A-Za-z0-9.-]+:[A-Za-z0-9._~/+@-]+$/;

/** Slugs with an install or uninstall in progress. */
const busySlugs = new Set<string>();

/**
 * Checks that `source` is an https or ssh git URL (or `file:` when allowed).
 * Anything else, such as `ext::` transports or local paths, throws.
 */
export function validateGitSource(source: string, allowFile = false): string {
  const trimmed = source.trim();
  if (trimmed.length === 0 || /[\s\0]/.test(trimmed) || trimmed.startsWith('-')) {
    throw new Error('Install source must be an https or ssh git URL');
  }
  if (SCP_LIKE_SOURCE.test(trimmed)) return trimmed;

  let url: URL | null = null;
  try {
    url = new URL(trimmed);
  } catch {
    url = null;
  }
  if (url) {
    if ((url.protocol === 'https:' || url.protocol === 'ssh:') && url.hostname !== '') {
      return trimmed;
    }
    if (url.protocol === 'file:' && allowFile) return trimmed;
  }
  throw new Error('Install source must be an https or ssh git URL');
}

export async function installApp(options: InstallOptions): Promise<InstallResult> {
  const { logger, paths } = options;
  const allowFile = options.allowFileSources === true;
  const source = validateGitSource(options.source, allowFile);
  const timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };

  const stagingRoot = join(paths.apps, '.staging');
  mkdirSync(stagingRoot, { recursive: true });
  const stagingPath = join(stagingRoot, `install-${Date.now()}-${randomUUID().slice(0, 8)}`);
  let lockedSlug: string | null = null;
  let envDir: string | null = null;

  try {
    logger.info(`cloning ${source}`);
    await runChecked({
      label: 'git clone',
      cmd: ['git', 'clone', '--depth', '1', '--', source, stagingPath],
      env: gitEnv(allowFile),
      timeoutMs: timeouts.gitMs,
      logger,
    });
    const manifestPath = join(stagingPath, MANIFEST_FILE);
    if (!existsSync(manifestPath)) {
      throw new Error('Cloned repository does not contain gosai.app.json');
    }
    const manifest = parseManifest(manifestPath, (warning) =>
      logger.warn(`manifest warning: ${warning}`),
    );
    const incompatible = sdkIncompatibility(manifest, options.sdkVersion);
    if (incompatible) throw new Error(incompatible);
    if (manifest.sdk === undefined) {
      logger.warn(`manifest has no \`sdk\` range; add one such as "^${SDK_VERSION}"`);
    }
    const slug = assertSlug(options.slugOverride ?? manifest.slug, 'app slug');
    if (busySlugs.has(slug)) {
      throw new Error(`App ${slug} is already being installed or uninstalled`);
    }
    busySlugs.add(slug);
    lockedSlug = slug;

    const finalPath = join(paths.apps, slug);
    if (existsSync(finalPath)) {
      throw new Error(`App ${slug} is already installed at ${finalPath}`);
    }
    options.checkManifest?.(manifest);
    if (manifest.python) {
      if (!options.python) {
        throw new Error(
          `${slug} ships Python drivers, but GOSAI's Python runtime is not available`,
        );
      }
      appDriversDir(stagingPath, manifest.python);
    }

    await maybeInstallJsDeps({ appPath: stagingPath, logger, timeoutMs: timeouts.jsInstallMs });
    await maybeRunBuild({ appPath: stagingPath, logger, timeoutMs: timeouts.buildMs });

    if (manifest.python && options.python) {
      envDir = appPythonEnvDir(paths, 'installed', slug);
      logger.info('building the python environment of the app', { app: slug, envDir });
      await buildAppPythonEnv({
        toolchain: options.python,
        envDir,
        appDir: stagingPath,
        python: manifest.python,
        logger,
        timeoutMs: timeouts.pythonMs,
      });
    }

    moveIntoPlace(stagingPath, finalPath);
    return { cloned: true, app: { manifest, installPath: finalPath } };
  } catch (err) {
    rmSync(stagingPath, { recursive: true, force: true });
    if (envDir !== null) removeAppPythonEnv(envDir);
    throw err;
  } finally {
    if (lockedSlug !== null) busySlugs.delete(lockedSlug);
  }
}

/**
 * Deletes the app's checkout and Python environment. Its data under
 * `paths.data` is the caller's business.
 */
export async function uninstallApp(slug: string, paths: GosaiPaths): Promise<void> {
  assertSlug(slug, 'app slug');
  if (busySlugs.has(slug)) {
    throw new Error(`App ${slug} is already being installed or uninstalled`);
  }
  const target = join(paths.apps, slug);
  if (!existsSync(target)) {
    throw new Error(`App ${slug} is not installed`);
  }
  busySlugs.add(slug);
  try {
    rmSync(target, { recursive: true, force: true });
    removeAppPythonEnv(appPythonEnvDir(paths, 'installed', slug));
  } finally {
    busySlugs.delete(slug);
  }
}

function gitEnv(allowFile: boolean): Record<string, string> {
  return {
    // Never wait for a username, password or passphrase on a terminal.
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes',
    // Also covers redirects and submodules.
    GIT_ALLOW_PROTOCOL: allowFile ? 'https:ssh:file' : 'https:ssh',
  };
}

interface JsInstallOptions {
  readonly appPath: string;
  readonly logger: ChildLogger;
  readonly timeoutMs: number;
}

/**
 * Installs the app's runtime `dependencies`, which its build may bundle.
 * `devDependencies`, such as `@gosai/sdk` and TypeScript for editors and type
 * checking, are skipped: the build keeps the SDK external. A committed bun
 * lockfile is honoured.
 */
async function maybeInstallJsDeps(opts: JsInstallOptions): Promise<void> {
  const packageJsonPath = join(opts.appPath, 'package.json');
  if (!existsSync(packageJsonPath)) return;

  let parsed: { dependencies?: Record<string, string> };
  try {
    parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  } catch (err) {
    opts.logger.warn('invalid package.json, skipping install', { err: String(err) });
    return;
  }
  const count = Object.keys(parsed.dependencies ?? {}).length;
  if (count === 0) {
    opts.logger.info('no runtime dependencies declared, skipping bun install');
    return;
  }

  const cmd = ['bun', 'install', '--production'];
  if (['bun.lock', 'bun.lockb'].some((file) => existsSync(join(opts.appPath, file)))) {
    cmd.push('--frozen-lockfile');
  }
  opts.logger.info('installing app dependencies via bun', { count, command: cmd.join(' ') });
  await runChecked({
    label: 'bun install',
    cmd,
    cwd: opts.appPath,
    timeoutMs: opts.timeoutMs,
    logger: opts.logger,
  });
}

async function maybeRunBuild(opts: JsInstallOptions): Promise<void> {
  const packageJson = join(opts.appPath, 'package.json');
  if (!existsSync(packageJson)) return;
  let parsed: { scripts?: Record<string, string> };
  try {
    parsed = JSON.parse(readFileSync(packageJson, 'utf8')) as {
      scripts?: Record<string, string>;
    };
  } catch (err) {
    opts.logger.warn('invalid package.json, skipping build', { err: String(err) });
    return;
  }
  if (!parsed.scripts?.build) return;
  opts.logger.info('running app build script');
  await runChecked({
    label: 'app build',
    cmd: ['bun', 'run', 'build'],
    cwd: opts.appPath,
    timeoutMs: opts.timeoutMs,
    logger: opts.logger,
  });
}

/**
 * Renames the finished staging directory into place. Copies only when the
 * apps directory is on another filesystem (EXDEV), and never over an
 * existing directory.
 */
function moveIntoPlace(from: string, to: string): void {
  if (existsSync(to)) throw new Error(`${to} already exists`);
  try {
    renameSync(from, to);
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
  }
  try {
    cpSync(from, to, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
  } catch (err) {
    rmSync(to, { recursive: true, force: true });
    throw err;
  }
  rmSync(from, { recursive: true, force: true });
}
