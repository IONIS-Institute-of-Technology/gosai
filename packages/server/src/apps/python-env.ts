/**
 * Python environments of apps that ship drivers (the manifest's `python`).
 *
 * Each app gets a virtual environment of its own:
 *
 *   <GOSAI home>/python-envs/installed/<slug>/   apps installed from git
 *   <GOSAI home>/python-envs/builtin/<slug>/     apps bundled with GOSAI
 *
 * Each holds `.venv/`, `constraints.txt`, `gosai-env.json` and `pycache/`,
 * where the app's bridge writes bytecode instead of the app directory (which
 * may be inside a signed bundle).
 *
 * The environment is layered on GOSAI's own Python environment, the one the
 * built-in `gosai-bridge` runs in. A `.pth` file appends the base
 * environment's site-packages to the app's `sys.path`, so `gosai_py` and its
 * dependencies (numpy, OpenCV, MediaPipe, ...) are importable without being
 * installed again, and app drivers subclass `gosai_py.BaseDriver` directly.
 * `uv pip install` then adds the app's requirements. Every package the base
 * environment has is passed as a constraint pinned to the base version, so an
 * app can't replace numpy under gosai_py: a conflicting requirement fails the
 * install with uv's explanation instead of breaking at runtime.
 *
 * uv only looks at the app's own site-packages, not at packages the `.pth`
 * file adds. A requirement that depends on a base package, such as a library
 * needing numpy, gets another copy of it installed in the app's environment,
 * at the base version. That costs the download (or the uv cache) and disk
 * space, tens to hundreds of MB for numpy or OpenCV, and the app's process
 * then imports that copy, since its own site-packages come first on
 * `sys.path`. The built-in bridge is unaffected.
 *
 * Requirements are the app's business: they may name other package indexes
 * and install modules that shadow base ones, but only inside the app's own
 * environment and bridge process. Editable local requirements (`-e ./pkg`)
 * are refused, since they would point into the install staging directory.
 *
 * `gosai-env.json` records what the environment was built from: the base
 * interpreter, the base packages and the requirements file. When any of them
 * changes, for example after a GOSAI update, `ensureAppPythonEnv` builds the
 * environment again.
 *
 * uv is GOSAI's own: the bundled binary in packaged builds, `uv` on PATH from
 * source. Its cache is `uvCacheDir` when set, and uv's default otherwise.
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { PythonConfig } from '@gosai/shared';
import { assertSlug } from '@gosai/shared/slug';
import type { ChildLogger } from '../logger/logger.js';
import type { GosaiPaths } from '../paths.js';
import { runChecked } from './run-step.js';

/** What app environments are built from. */
export interface PythonToolchain {
  /** The GOSAI Python project. Its `.venv` runs the built-in drivers. */
  readonly pythonDir: string;
  /** The uv executable: a path, or a command name looked up on PATH. */
  readonly uv: string;
  /** `UV_CACHE_DIR` for app installs. uv's default cache when omitted. */
  readonly uvCacheDir?: string;
}

/** Installed and built-in apps may share a slug, so their environments live apart. */
export type AppEnvKind = 'installed' | 'builtin';

export interface AppEnvOptions {
  readonly toolchain: PythonToolchain;
  /** From `appPythonEnvDir`. */
  readonly envDir: string;
  /** The app's root directory, where the manifest's paths start. */
  readonly appDir: string;
  readonly python: PythonConfig;
  readonly logger: ChildLogger;
  readonly timeoutMs?: number;
  readonly platform?: NodeJS.Platform;
  /** Kills uv and rejects when aborted. The environment is removed. */
  readonly signal?: AbortSignal;
}

const STAMP_FILE = 'gosai-env.json';
const CONSTRAINTS_FILE = 'constraints.txt';
const BASE_PTH = '_gosai_base.pth';
const STAMP_FORMAT = 1;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

interface EnvStamp {
  readonly format: number;
  /** `home` and version of the base interpreter, from the base `pyvenv.cfg`. */
  readonly interpreter: string;
  /** sha256 of the constraints. */
  readonly constraints: string;
  /** sha256 of the requirements file, or null without one. */
  readonly requirements: string | null;
}

export function appPythonEnvDir(
  paths: Pick<GosaiPaths, 'root'>,
  kind: AppEnvKind,
  slug: string,
): string {
  return join(paths.root, 'python-envs', kind, assertSlug(slug, 'app slug'));
}

/** Where the app's bridge writes bytecode (`PYTHONPYCACHEPREFIX`). */
export function appPycacheDir(envDir: string): string {
  return join(envDir, 'pycache');
}

/** The interpreter of the venv in `envDir`. */
export function appEnvPython(envDir: string, platform: NodeJS.Platform = process.platform): string {
  return venvPython(join(envDir, '.venv'), platform);
}

function venvPython(venv: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? join(venv, 'Scripts', 'python.exe') : join(venv, 'bin', 'python');
}

/** `Lib/site-packages` on Windows, `lib/python3.X/site-packages` elsewhere. */
function sitePackages(venv: string, platform: NodeJS.Platform): string {
  if (platform === 'win32') return join(venv, 'Lib', 'site-packages');
  const lib = join(venv, 'lib');
  const version = existsSync(lib)
    ? readdirSync(lib).find((name) => /^python\d+\.\d+$/.test(name))
    : undefined;
  if (!version) throw new Error(`no site-packages in ${venv}`);
  return join(lib, version, 'site-packages');
}

/**
 * A path relative to the app root, with symlinks resolved, refusing any that
 * leave the app. The Python side resolves the driver package the same way.
 */
export function resolveAppPath(appDir: string, path: string): string {
  const root = realOrResolved(appDir);
  const full = realOrResolved(resolve(root, path));
  const rel = relative(root, full);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`${path} is outside the app`);
  }
  return full;
}

function realOrResolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** The app's driver package directory. Throws when it is missing. */
export function appDriversDir(appDir: string, python: PythonConfig): string {
  const dir = resolveAppPath(appDir, python.drivers);
  if (!existsSync(dir)) throw new Error(`python.drivers ${python.drivers} does not exist`);
  return dir;
}

/** Environments being built, by directory, so two builds of one never overlap. */
const pending = new Map<string, Promise<unknown>>();

function serialized<T>(envDir: string, work: () => Promise<T>): Promise<T> {
  const previous = pending.get(envDir) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(work);
  pending.set(envDir, next);
  const clear = (): void => {
    if (pending.get(envDir) === next) pending.delete(envDir);
  };
  next.then(clear, clear);
  return next;
}

/** Builds the app's environment from scratch. Returns its interpreter. */
export function buildAppPythonEnv(options: AppEnvOptions): Promise<string> {
  return serialized(options.envDir, () => build(options));
}

/**
 * Returns the interpreter of the app's environment, building the environment
 * first when it is missing or was built from something else.
 */
export function ensureAppPythonEnv(options: AppEnvOptions): Promise<string> {
  return serialized(options.envDir, async () => {
    options.signal?.throwIfAborted();
    const platform = options.platform ?? process.platform;
    const python = appEnvPython(options.envDir, platform);
    const base = readBase(options.toolchain.pythonDir, platform);
    const wanted = stampFor(base, options);
    if (existsSync(python) && sameStamp(readStamp(options.envDir), wanted)) {
      // The base environment may have moved, e.g. to a new runtime directory.
      writeBasePth(options.envDir, base.sitePackages, platform);
      return python;
    }
    options.logger.info('building the python environment', { envDir: options.envDir });
    return build(options);
  });
}

/** Removes an app's environment. */
export function removeAppPythonEnv(envDir: string): void {
  rmSync(envDir, { recursive: true, force: true });
}

async function build(options: AppEnvOptions): Promise<string> {
  const { envDir, toolchain, logger, signal } = options;
  signal?.throwIfAborted();
  const platform = options.platform ?? process.platform;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  appDriversDir(options.appDir, options.python);
  const requirements = requirementsPath(options);
  if (requirements) checkRequirements(options.appDir, requirements);
  const base = readBase(toolchain.pythonDir, platform);
  const uv = findUv(toolchain.uv);
  const env: Record<string, string> = {
    UV_PYTHON_DOWNLOADS: 'never',
    ...(toolchain.uvCacheDir ? { UV_CACHE_DIR: toolchain.uvCacheDir } : {}),
  };

  rmSync(envDir, { recursive: true, force: true });
  mkdirSync(envDir, { recursive: true });
  try {
    const venv = join(envDir, '.venv');
    await runChecked({
      label: 'uv venv',
      cmd: [uv, 'venv', '--no-project', '--python', base.python, venv],
      cwd: envDir,
      env,
      timeoutMs,
      logger,
      processGroup: true,
      ...(signal ? { signal } : {}),
    });
    writeBasePth(envDir, base.sitePackages, platform);
    const constraints = join(envDir, CONSTRAINTS_FILE);
    writeFileSync(constraints, base.constraints);
    const python = venvPython(venv, platform);
    if (requirements) {
      logger.info('installing python requirements with uv', { requirements });
      await runChecked({
        label: 'uv pip install',
        cmd: [uv, 'pip', 'install', '--python', python, '-r', requirements, '-c', constraints],
        cwd: options.appDir,
        env,
        timeoutMs,
        logger,
        processGroup: true,
        ...(signal ? { signal } : {}),
      });
    }
    writeFileSync(
      join(envDir, STAMP_FILE),
      `${JSON.stringify(stampFor(base, options), null, 2)}\n`,
    );
    return python;
  } catch (err) {
    rmSync(envDir, { recursive: true, force: true });
    throw err;
  }
}

function requirementsPath(options: AppEnvOptions): string | null {
  const declared = options.python.requirements;
  if (declared === undefined) return null;
  const path = resolveAppPath(options.appDir, declared);
  if (!existsSync(path)) throw new Error(`python.requirements ${declared} does not exist`);
  return path;
}

/** `-r`, `-c` and `-e` options with their value, in either spelling. */
const REQUIREMENT_OPTION = /^(-r|--requirement|-c|--constraint|-e|--editable)(?:\s*=\s*|\s+)(\S+)/;

/**
 * Refuses editable local requirements, in the file or the files it includes:
 * the environment is built while the app is in a staging directory that is
 * renamed afterwards, so an editable install would point at a path that is
 * gone.
 */
export function checkRequirements(appDir: string, file: string, seen = new Set<string>()): void {
  if (seen.has(file)) return;
  seen.add(file);
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  for (const [index, raw] of lines.entries()) {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    const match = REQUIREMENT_OPTION.exec(line);
    if (!match) continue;
    const [, option, value] = match as unknown as [string, string, string];
    const where = `${relative(appDir, file) || file}:${index + 1}`;
    if (option === '-e' || option === '--editable') {
      if (/^file:/i.test(value) || !/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
        throw new Error(
          `${where}: editable local requirements such as "${line}" are not supported; ` +
            'list the package without -e',
        );
      }
      continue;
    }
    const included = resolve(dirname(file), value);
    if (existsSync(included)) checkRequirements(appDir, included, seen);
  }
}

function findUv(uv: string): string {
  if (uv.includes('/') || uv.includes('\\')) {
    if (!existsSync(uv)) throw new Error(`uv was not found at ${uv}`);
    return uv;
  }
  const found = Bun.which(uv);
  if (!found) throw new Error(`${uv} was not found on PATH; install uv to use app Python drivers`);
  return found;
}

interface BaseEnv {
  readonly python: string;
  readonly sitePackages: string;
  readonly interpreter: string;
  /** `name==version` for every package of the base environment except gosai-py. */
  readonly constraints: string;
}

function readBase(pythonDir: string, platform: NodeJS.Platform): BaseEnv {
  const venv = join(pythonDir, '.venv');
  const python = venvPython(venv, platform);
  if (!existsSync(python)) {
    throw new Error(`the GOSAI Python environment is missing at ${venv}`);
  }
  const config = readFileSync(join(venv, 'pyvenv.cfg'), 'utf8');
  const setting = (key: string): string =>
    new RegExp(`^\\s*${key}\\s*=\\s*(.*?)\\s*$`, 'm').exec(config)?.[1] ?? '';
  const site = sitePackages(venv, platform);
  const packages = readdirSync(site)
    .flatMap((name) => {
      const match = /^([^-]+)-(.+)\.dist-info$/.exec(name);
      if (!match) return [];
      const [, dist, version] = match as unknown as [string, string, string];
      return dist.toLowerCase().replace(/[-_.]+/g, '-') === 'gosai-py'
        ? []
        : [`${dist}==${version}`];
    })
    .sort();
  return {
    python,
    sitePackages: site,
    interpreter: `${setting('home')} ${setting('version_info') || setting('version')}`,
    constraints: packages.map((line) => `${line}\n`).join(''),
  };
}

function writeBasePth(envDir: string, baseSitePackages: string, platform: NodeJS.Platform): void {
  const path = join(sitePackages(join(envDir, '.venv'), platform), BASE_PTH);
  // `.pth` lines starting with `import` run at startup. addsitedir also reads
  // the base environment's own .pth files, such as a source checkout's
  // editable gosai-py. A JSON string is a valid Python string literal.
  const content = `import site; site.addsitedir(${JSON.stringify(baseSitePackages)})\n`;
  if (existsSync(path) && readFileSync(path, 'utf8') === content) return;
  writeFileSync(path, content);
}

function stampFor(base: BaseEnv, options: AppEnvOptions): EnvStamp {
  const requirements = requirementsPath(options);
  return {
    format: STAMP_FORMAT,
    interpreter: base.interpreter,
    constraints: sha256(base.constraints),
    requirements: requirements ? sha256(readFileSync(requirements)) : null,
  };
}

function readStamp(envDir: string): EnvStamp | null {
  try {
    return JSON.parse(readFileSync(join(envDir, STAMP_FILE), 'utf8')) as EnvStamp;
  } catch {
    return null;
  }
}

function sameStamp(a: EnvStamp | null, b: EnvStamp): boolean {
  return (
    a !== null &&
    a.format === b.format &&
    a.interpreter === b.interpreter &&
    a.constraints === b.constraints &&
    a.requirements === b.requirements
  );
}

function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}
