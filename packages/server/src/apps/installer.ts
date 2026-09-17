/**
 * App installation. Clones a git repository into a staging directory,
 * validates its manifest, installs JavaScript dependencies, runs the build and
 * (optionally) installs Python requirements via uv. The app only moves into
 * the apps directory once every step succeeded; a failed install removes the
 * staging directory.
 */

import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { AppManifest } from '@gosai/shared';
import { assertSlug } from '@gosai/shared/slug';
import type { ChildLogger } from '../logger/logger.js';
import type { GosaiPaths } from '../paths.js';
import { MANIFEST_FILE, parseManifest, type DiscoveredApp } from './manifest.js';
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
  readonly pythonDir?: string;
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

/** How long to keep reading output after a killed step exits. */
const OUTPUT_GRACE_MS = 1000;
const ERROR_TAIL_LINES = 20;

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

    await maybeInstallJsDeps({ appPath: stagingPath, logger, timeoutMs: timeouts.jsInstallMs });
    await maybeRunBuild({ appPath: stagingPath, logger, timeoutMs: timeouts.buildMs });

    if (manifest.python?.requirements && options.pythonDir) {
      await installPythonRequirements({
        appPath: stagingPath,
        requirements: manifest.python.requirements,
        logger,
        timeoutMs: timeouts.pythonMs,
      });
    }

    moveIntoPlace(stagingPath, finalPath);
    return { cloned: true, app: { manifest, installPath: finalPath } };
  } catch (err) {
    rmSync(stagingPath, { recursive: true, force: true });
    throw err;
  } finally {
    if (lockedSlug !== null) busySlugs.delete(lockedSlug);
  }
}

/** Deletes the app's checkout. Its data under `paths.data` is the caller's business. */
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

interface PyInstallOptions {
  readonly appPath: string;
  readonly requirements: string;
  readonly logger: ChildLogger;
  readonly timeoutMs: number;
}

async function installPythonRequirements(opts: PyInstallOptions): Promise<void> {
  const requirementsPath = join(opts.appPath, opts.requirements);
  if (!existsSync(requirementsPath)) {
    opts.logger.warn('declared requirements file missing', { path: requirementsPath });
    return;
  }
  opts.logger.info('installing python requirements via uv pip', {
    requirements: requirementsPath,
  });
  await runChecked({
    label: 'uv pip install',
    cmd: ['uv', 'pip', 'install', '-r', requirementsPath],
    cwd: opts.appPath,
    timeoutMs: opts.timeoutMs,
    logger: opts.logger,
  });
}

interface JsInstallOptions {
  readonly appPath: string;
  readonly logger: ChildLogger;
  readonly timeoutMs: number;
}

async function maybeInstallJsDeps(opts: JsInstallOptions): Promise<void> {
  const packageJsonPath = join(opts.appPath, 'package.json');
  if (!existsSync(packageJsonPath)) return;

  let parsed: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  try {
    parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  } catch (err) {
    opts.logger.warn('invalid package.json, skipping install', { err: String(err) });
    return;
  }
  const count =
    Object.keys(parsed.dependencies ?? {}).length +
    Object.keys(parsed.devDependencies ?? {}).length;
  if (count === 0) {
    opts.logger.info('no dependencies declared, skipping bun install');
    return;
  }

  opts.logger.info('installing app dependencies via bun', { count });
  await runChecked({
    label: 'bun install',
    cmd: ['bun', 'install'],
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

interface StepOptions {
  readonly label: string;
  readonly cmd: string[];
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly timeoutMs: number;
  readonly logger: ChildLogger;
}

interface StepResult {
  readonly code: number;
  /** Last lines of combined stdout and stderr. */
  readonly tail: readonly string[];
}

/**
 * Runs one install step. stdout and stderr stream to the logger line by line,
 * so a noisy step can't fill a pipe and block. The step is killed after
 * `timeoutMs`, which rejects.
 */
async function runStep(opts: StepOptions): Promise<StepResult> {
  const env: Record<string, string | undefined> = { ...process.env, ...opts.env };
  // App build scripts are third-party code and must not see server secrets.
  delete env.GOSAI_DASHBOARD_TOKEN;

  const child = Bun.spawn({
    cmd: opts.cmd,
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const tail: string[] = [];
  const onLine = (line: string, stream: 'stdout' | 'stderr'): void => {
    if (line.trim() === '') return;
    opts.logger.info(`[${opts.label}] ${line}`, { stream });
    tail.push(line);
    if (tail.length > ERROR_TAIL_LINES) tail.shift();
  };
  const readers = [child.stdout.getReader(), child.stderr.getReader()] as const;
  const pumps = Promise.all([
    pumpLines(readers[0], (line) => onLine(line, 'stdout')),
    pumpLines(readers[1], (line) => onLine(line, 'stderr')),
  ]);

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, opts.timeoutMs);
  const code = await child.exited;
  clearTimeout(timer);

  // A killed step can leave grandchildren holding the pipes open, so stop
  // reading after a short grace period.
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const grace = new Promise<void>((resolve) => {
    graceTimer = setTimeout(resolve, OUTPUT_GRACE_MS);
  });
  await Promise.race([pumps, grace]);
  clearTimeout(graceTimer);
  for (const reader of readers) void reader.cancel().catch(() => undefined);

  if (timedOut) {
    throw new Error(`${opts.label} timed out after ${Math.round(opts.timeoutMs / 1000)}s`);
  }
  return { code, tail };
}

async function runChecked(opts: StepOptions): Promise<void> {
  const result = await runStep(opts);
  if (result.code !== 0) throw stepError(opts.label, result);
}

function stepError(label: string, result: StepResult): Error {
  const output = result.tail.join('\n').trim();
  return new Error(`${label} failed (exit ${result.code}): ${output || 'no output'}`);
}

interface ChunkReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
}

async function pumpLines(reader: ChunkReader, onLine: (line: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) onLine(line);
    }
  } catch {
    // Reader cancelled after a timeout.
  }
  buffer += decoder.decode();
  if (buffer !== '') onLine(buffer);
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
