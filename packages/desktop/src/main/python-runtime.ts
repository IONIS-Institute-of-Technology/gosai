/**
 * The writable Python runtime of packaged builds. No Electron import, so the
 * packaging scripts and tests can use it.
 *
 * Bundles ship the Python source tree read-only, plus `python-runtime.json`
 * with a hash of that tree and the Python version from pyproject.toml, both
 * computed at package time. On launch the tree is copied into
 *
 *   ~/.gosai-runtime/python-<key>/python/    the tree and its .venv
 *   ~/.gosai-runtime/cpython/                uv-managed interpreters, shared
 *
 * where `key` covers the tree hash, the Python version and the extras, so
 * bundles with the same requirements share a runtime.
 *
 * The runtime is built in a staging directory under a lock file, gets a
 * `.complete` marker, and is renamed into place only once `uv sync` finished.
 * The venv is relocatable and the project is installed without editable
 * links, so the rename doesn't break it. Runtimes that no running process
 * uses are deleted once a newer one is ready.
 */

import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { basename, join } from 'node:path';

/** Written in the runtime directory once every install step succeeded. */
export const COMPLETE_MARKER = '.complete';
/** One file per process using the runtime, named after its pid. */
const IN_USE_DIR = '.in-use';
const RUNTIME_PREFIX = 'python-';
const STAGING_PREFIX = '.staging-';

/** Never shipped and never hashed. */
const IGNORED_NAMES = new Set(['.venv', '__pycache__', '.pytest_cache', '.ruff_cache']);

export interface PythonRuntimeInfo {
  /** sha256 of the bundled Python tree. */
  readonly treeHash: string;
  /** `major.minor` from `requires-python`. */
  readonly python: string;
}

function isIgnored(name: string): boolean {
  return IGNORED_NAMES.has(name) || name.endsWith('.pyc');
}

/** sha256 over the relative path and contents of every file the bundle ships. */
export function hashPythonTree(root: string): string {
  const hash = createHash('sha256');
  const walk = (directory: string, prefix: string): void => {
    for (const name of readdirSync(directory).sort()) {
      if (isIgnored(name)) continue;
      const path = join(directory, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const stat = statSync(path);
      if (stat.isDirectory()) {
        walk(path, relative);
      } else if (stat.isFile()) {
        hash.update(`${relative}\0${stat.size}\0`);
        hash.update(readFileSync(path));
      }
    }
  };
  walk(root, '');
  return hash.digest('hex');
}

/**
 * The lowest `major.minor` allowed by `requires-python`, e.g. `3.12` for
 * `>=3.12`. uv installs that version when the machine has no match.
 */
export function pythonVersionFromPyproject(pyproject: string): string {
  const match = /^\s*requires-python\s*=\s*["']([^"']+)["']/m.exec(pyproject);
  if (!match) throw new Error('pyproject.toml has no requires-python');
  const spec = match[1]!;
  const version = /(?:>=|~=|==)\s*(\d+\.\d+)/.exec(spec);
  if (!version) {
    throw new Error(`requires-python "${spec}" has no lower bound (>=, ~= or ==)`);
  }
  return version[1]!;
}

export function pythonRuntimeInfo(pythonDir: string): PythonRuntimeInfo {
  return {
    treeHash: hashPythonTree(pythonDir),
    python: pythonVersionFromPyproject(readFileSync(join(pythonDir, 'pyproject.toml'), 'utf8')),
  };
}

export function readPythonRuntimeInfo(path: string): PythonRuntimeInfo {
  if (!existsSync(path)) {
    throw new Error(`the bundle is missing ${basename(path)}; repackage it`);
  }
  const info = JSON.parse(readFileSync(path, 'utf8')) as Partial<PythonRuntimeInfo>;
  if (typeof info.treeHash !== 'string' || typeof info.python !== 'string') {
    throw new Error(`${path} needs "treeHash" and "python"`);
  }
  return { treeHash: info.treeHash, python: info.python };
}

/** Directory name of a runtime, `python-<12 hex>`. */
export function runtimeName(info: PythonRuntimeInfo, extras: readonly string[]): string {
  const key = createHash('sha256')
    .update([info.treeHash, info.python, [...extras].sort().join(',')].join('\n'))
    .digest('hex')
    .slice(0, 12);
  return `${RUNTIME_PREFIX}${key}`;
}

/** The venv's `gosai-bridge` entry point. Windows venvs use `Scripts` and `.exe`. */
export function bridgeExecutable(pythonDir: string, platform: NodeJS.Platform): string {
  return platform === 'win32'
    ? join(pythonDir, '.venv', 'Scripts', 'gosai-bridge.exe')
    : join(pythonDir, '.venv', 'bin', 'gosai-bridge');
}

export interface MaterializeOptions {
  /** The read-only Python tree shipped in the bundle. */
  readonly sourceDir: string;
  /** Usually `~/.gosai-runtime`. */
  readonly runtimeRoot: string;
  /** From `runtimeName()`. */
  readonly name: string;
  /** uv argument lists to run in order inside the staged python directory. */
  readonly commands: readonly (readonly string[])[];
  /** Runs uv with `args` in `cwd`. */
  readonly runUv: (args: readonly string[], cwd: string) => Promise<void>;
  readonly onStatus?: (message: string) => void;
  readonly platform?: NodeJS.Platform;
  readonly pid?: number;
  /** How often to look at another process's lock. */
  readonly lockPollMs?: number;
}

/**
 * Returns the python directory of a complete runtime, building it first when
 * needed, and records this process as a user of it.
 */
export async function materializeRuntime(options: MaterializeOptions): Promise<string> {
  const { runtimeRoot, name } = options;
  const pid = options.pid ?? process.pid;
  const platform = options.platform ?? process.platform;
  const onStatus = options.onStatus ?? (() => undefined);
  const finalDir = join(runtimeRoot, name);
  mkdirSync(runtimeRoot, { recursive: true });

  if (!isComplete(finalDir)) {
    const lockPath = join(runtimeRoot, `${name}.lock`);
    await acquireLock(lockPath, pid, options.lockPollMs ?? 1000, () => {
      onStatus('Waiting for another GOSAI instance to finish installing Python…');
    });
    try {
      if (!isComplete(finalDir)) await build(options, finalDir, pid, platform, onStatus);
    } finally {
      releaseLock(lockPath, pid);
    }
  }

  markInUse(finalDir, pid);
  return join(finalDir, 'python');
}

async function build(
  options: MaterializeOptions,
  finalDir: string,
  pid: number,
  platform: NodeJS.Platform,
  onStatus: (message: string) => void,
): Promise<void> {
  const staging = join(options.runtimeRoot, `${STAGING_PREFIX}${options.name}-${pid}`);
  const stagedPython = join(staging, 'python');
  rmSync(staging, { recursive: true, force: true });
  try {
    onStatus('Preparing the Python runtime (first launch)…');
    cpSync(options.sourceDir, stagedPython, {
      recursive: true,
      filter: (src) => !isIgnored(basename(src)),
    });

    onStatus('Installing Python and the driver dependencies…');
    for (const args of options.commands) await options.runUv(args, stagedPython);

    if (!existsSync(bridgeExecutable(stagedPython, platform))) {
      throw new Error('uv sync finished but the gosai-bridge entry point is missing');
    }
    writeFileSync(
      join(staging, COMPLETE_MARKER),
      `${JSON.stringify({ commands: options.commands, completedAt: new Date().toISOString() })}\n`,
    );
    if (isComplete(finalDir)) {
      // Another process that took over a dead lock at the same time won.
      rmSync(staging, { recursive: true, force: true });
      return;
    }
    // Without a marker nothing uses it: an interrupted older layout.
    rmSync(finalDir, { recursive: true, force: true });
    renameSync(staging, finalDir);
  } catch (err) {
    rmSync(staging, { recursive: true, force: true });
    throw err;
  }
}

export function isComplete(runtimeDir: string): boolean {
  return existsSync(join(runtimeDir, COMPLETE_MARKER));
}

/** True when a process with this pid exists. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function lockOwner(lockPath: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(lockPath, 'utf8'), 10);
    return Number.isSafeInteger(pid) ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Creates `lockPath` holding our pid. Waits while a live process holds it and
 * takes over the lock of a dead one.
 */
async function acquireLock(
  lockPath: string,
  pid: number,
  pollMs: number,
  onWait: () => void,
): Promise<void> {
  let waiting = false;
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx');
      try {
        writeSync(fd, String(pid));
      } finally {
        closeSync(fd);
      }
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    const owner = lockOwner(lockPath);
    if (owner === pid || (owner !== null && !isProcessAlive(owner)) || isAbandoned(lockPath)) {
      rmSync(lockPath, { force: true });
      continue;
    }
    if (!waiting) {
      waiting = true;
      onWait();
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/**
 * A lock without a pid is normal for the instant between creating and
 * writing it. One that stays empty belongs to a process that died there.
 */
function isAbandoned(lockPath: string): boolean {
  try {
    return lockOwner(lockPath) === null && Date.now() - statSync(lockPath).mtimeMs > 10_000;
  } catch {
    return false;
  }
}

function releaseLock(lockPath: string, pid: number): void {
  if (lockOwner(lockPath) === pid) rmSync(lockPath, { force: true });
}

export function markInUse(runtimeDir: string, pid: number = process.pid): void {
  const dir = join(runtimeDir, IN_USE_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, String(pid)), '');
}

export function releaseInUse(runtimeDir: string, pid: number = process.pid): void {
  rmSync(join(runtimeDir, IN_USE_DIR, String(pid)), { force: true });
}

function hasLiveUsers(runtimeDir: string, isAlive: (pid: number) => boolean): boolean {
  const dir = join(runtimeDir, IN_USE_DIR);
  if (!existsSync(dir)) return false;
  let live = false;
  for (const name of readdirSync(dir)) {
    const pid = Number.parseInt(name, 10);
    if (Number.isSafeInteger(pid) && isAlive(pid)) live = true;
    else rmSync(join(dir, name), { force: true });
  }
  return live;
}

/**
 * Deletes runtimes other than `keep` that no live process uses or builds,
 * and staging directories whose builder died. Returns the deleted names.
 */
export function cleanStaleRuntimes(
  runtimeRoot: string,
  keep: string,
  isAlive: (pid: number) => boolean = isProcessAlive,
): string[] {
  if (!existsSync(runtimeRoot)) return [];
  hasLiveUsers(join(runtimeRoot, keep), isAlive); // prunes dead users
  const removed: string[] = [];
  for (const name of readdirSync(runtimeRoot)) {
    const path = join(runtimeRoot, name);
    if (name.startsWith(RUNTIME_PREFIX) && name.endsWith('.lock')) {
      const owner = lockOwner(path);
      if (name !== `${keep}.lock` && owner !== null && !isAlive(owner)) {
        rmSync(path, { force: true });
      }
      continue;
    }
    if (name.startsWith(STAGING_PREFIX)) {
      const pid = Number.parseInt(name.slice(name.lastIndexOf('-') + 1), 10);
      if (Number.isSafeInteger(pid) && isAlive(pid)) continue;
    } else if (name.startsWith(RUNTIME_PREFIX) && name !== keep) {
      const builder = lockOwner(join(runtimeRoot, `${name}.lock`));
      if (builder !== null && isAlive(builder)) continue;
      if (hasLiveUsers(path, isAlive)) continue;
    } else {
      continue;
    }
    if (!statSync(path).isDirectory()) continue;
    rmSync(path, { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}
