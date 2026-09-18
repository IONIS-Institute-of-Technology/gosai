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
 * links, so the rename doesn't break it.
 *
 * A runtime nobody runs is deleted when a newer runtime of the same family
 * (same app and extras) is ready, or when it went unused for 30 days.
 * Processes record their use in `.in-use/<runtime>/<pid>` with their boot
 * time, since pids are reused after a reboot.
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { uptime } from 'node:os';
import { basename, join } from 'node:path';
import { bridgeExecutable } from '@gosai/shared/python-bridge';

/** Written in the runtime directory once every install step succeeded. */
export const COMPLETE_MARKER = '.complete';
/** Rewritten in the runtime directory at every launch that uses it. */
export const LAST_USED = '.last-used';
/**
 * `.in-use/<runtime>/<pid>`, one file per process using a runtime. It sits
 * beside the runtimes so a process can register before the runtime exists.
 */
const IN_USE_DIR = '.in-use';
const RUNTIME_PREFIX = 'python-';
const STAGING_PREFIX = '.staging-';
const TRASH_PREFIX = '.trash-';

export const DEFAULT_MAX_UNUSED_MS = 30 * 24 * 60 * 60 * 1000;
/** Boot times derived from the uptime drift a little. Two boots are further apart. */
const BOOT_TOLERANCE_MS = 60_000;
const LOCK_HEARTBEAT_MS = 10_000;
/** A lock whose holder stopped refreshing it for this long is taken over. */
export const LOCK_STALE_MS = 120_000;
/** A lock without contents is normal only for the instant between creating and writing it. */
const EMPTY_LOCK_STALE_MS = 10_000;
/** A trash directory this old was left by a delete that got interrupted. */
const TRASH_STALE_MS = 60_000;

/** Never shipped and never hashed. */
const IGNORED_NAMES = new Set(['.venv', '__pycache__', '.pytest_cache', '.ruff_cache']);
/** Top-level directories of python/ that don't ship either. */
const IGNORED_TOP_LEVEL = new Set(['tests']);

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
      if (isIgnored(name) || (prefix === '' && IGNORED_TOP_LEVEL.has(name))) continue;
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

/** How this module sees processes and time. Tests replace it. */
export interface ProcessProbe {
  readonly isAlive: (pid: number) => boolean;
  /** When this machine booted, in ms since the epoch. */
  readonly bootTime: number;
  readonly now: () => number;
}

export function systemProbe(): ProcessProbe {
  return { isAlive: isProcessAlive, bootTime: Date.now() - uptime() * 1000, now: Date.now };
}

/** A process as recorded in lock and in-use files. */
interface ProcessRecord {
  readonly pid: number;
  readonly bootTime: number;
}

/** True when the recorded process runs in this boot. A pid from a previous boot is dead. */
function isLive(record: ProcessRecord, probe: ProcessProbe): boolean {
  return (
    Math.abs(record.bootTime - probe.bootTime) <= BOOT_TOLERANCE_MS && probe.isAlive(record.pid)
  );
}

export interface MaterializeOptions {
  /** The read-only Python tree shipped in the bundle. */
  readonly sourceDir: string;
  /** Usually `~/.gosai-runtime`. */
  readonly runtimeRoot: string;
  /** From `runtimeName()`. */
  readonly name: string;
  /**
   * Runtimes of one family replace each other on upgrade, e.g. the app name
   * plus the extras. Other families are only deleted once unused for long.
   */
  readonly family: string;
  /** uv argument lists to run in order inside the staged python directory. */
  readonly commands: readonly (readonly string[])[];
  /** Runs uv with `args` in `cwd`. */
  readonly runUv: (args: readonly string[], cwd: string) => Promise<void>;
  readonly onStatus?: (message: string) => void;
  readonly platform?: NodeJS.Platform;
  readonly pid?: number;
  readonly probe?: ProcessProbe;
  /** How often to look at another process's lock. */
  readonly lockPollMs?: number;
  /** How often the lock holder refreshes its lock. */
  readonly lockHeartbeatMs?: number;
}

/**
 * Returns the python directory of a complete runtime, building it first when
 * needed, and records this process as a user of it.
 */
export async function materializeRuntime(options: MaterializeOptions): Promise<string> {
  const { runtimeRoot, name } = options;
  const pid = options.pid ?? process.pid;
  const probe = options.probe ?? systemProbe();
  const platform = options.platform ?? process.platform;
  const onStatus = options.onStatus ?? (() => undefined);
  const finalDir = join(runtimeRoot, name);
  mkdirSync(runtimeRoot, { recursive: true });

  // Register before looking, so a concurrent cleanup sees this process as a
  // user and keeps the runtime.
  markInUse(runtimeRoot, name, { pid, bootTime: probe.bootTime });
  try {
    if (!isComplete(finalDir)) {
      const lockPath = join(runtimeRoot, `${name}.lock`);
      const token = await acquireLock(lockPath, pid, probe, options.lockPollMs ?? 1000, () => {
        onStatus('Waiting for another GOSAI instance to finish installing Python…');
      });
      const heartbeat = setInterval(
        () => refreshLock(lockPath, token),
        options.lockHeartbeatMs ?? LOCK_HEARTBEAT_MS,
      );
      heartbeat.unref();
      try {
        if (!isComplete(finalDir)) await build(options, finalDir, pid, platform, onStatus);
      } finally {
        clearInterval(heartbeat);
        releaseLock(lockPath, token);
      }
    }
  } catch (err) {
    releaseInUse(runtimeRoot, name, pid);
    throw err;
  }

  writeFileSync(join(finalDir, LAST_USED), `${probe.now()}\n`);
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
    const marker = { family: options.family, commands: options.commands };
    writeFileSync(join(staging, COMPLETE_MARKER), `${JSON.stringify(marker)}\n`);
    moveIntoPlace(options.runtimeRoot, staging, finalDir);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * Renames the staged runtime to its final name. Never replaces a complete
 * runtime: if another process got there first, the staged copy is dropped.
 */
function moveIntoPlace(runtimeRoot: string, staging: string, finalDir: string): void {
  if (isComplete(finalDir)) return;
  if (existsSync(finalDir)) {
    // No marker, so nothing uses it: left by a manual edit or an old layout.
    const trash = trashPath(runtimeRoot, basename(finalDir));
    try {
      renameSync(finalDir, trash);
    } catch {
      // Gone already.
    }
    if (isComplete(trash)) {
      // Another builder finished in between: put its runtime back.
      renameSync(trash, finalDir);
      return;
    }
    rmSync(trash, { recursive: true, force: true });
  }
  try {
    renameSync(staging, finalDir);
  } catch (err) {
    if (!isComplete(finalDir)) throw err;
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

interface LockRecord extends ProcessRecord {
  readonly token: string;
}

function readLock(lockPath: string): LockRecord | null {
  try {
    const record = JSON.parse(readFileSync(lockPath, 'utf8')) as Partial<LockRecord>;
    if (
      typeof record.pid === 'number' &&
      typeof record.bootTime === 'number' &&
      typeof record.token === 'string'
    ) {
      return { pid: record.pid, bootTime: record.bootTime, token: record.token };
    }
  } catch {
    // Missing, empty or half-written.
  }
  return null;
}

/**
 * A lock is stale when its holder isn't running in this boot, when it
 * stopped refreshing it, or when it stayed empty. Null when there is no lock.
 */
function staleLockToken(lockPath: string, probe: ProcessProbe): string | 'empty' | null {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(lockPath).mtimeMs;
  } catch {
    return null;
  }
  const record = readLock(lockPath);
  const age = probe.now() - mtimeMs;
  if (!record) return age > EMPTY_LOCK_STALE_MS ? 'empty' : null;
  return !isLive(record, probe) || age > LOCK_STALE_MS ? record.token : null;
}

function isLockLive(lockPath: string, probe: ProcessProbe): boolean {
  return existsSync(lockPath) && staleLockToken(lockPath, probe) === null;
}

/**
 * Removes a lock judged stale. It is renamed first and checked again, so a
 * fresh lock another process created in between is put back.
 */
function removeStaleLock(lockPath: string, staleToken: string): void {
  const moved = `${lockPath}.${randomBytes(6).toString('hex')}.stale`;
  try {
    renameSync(lockPath, moved);
  } catch {
    return;
  }
  const record = readLock(moved);
  if (staleToken !== 'empty' && record && record.token !== staleToken && !existsSync(lockPath)) {
    renameSync(moved, lockPath);
    return;
  }
  rmSync(moved, { force: true });
}

/** Creates `lockPath` for this process and returns its token. Waits while it is held. */
async function acquireLock(
  lockPath: string,
  pid: number,
  probe: ProcessProbe,
  pollMs: number,
  onWait: () => void,
): Promise<string> {
  const token = randomBytes(12).toString('hex');
  const record: LockRecord = { pid, bootTime: probe.bootTime, token };
  let waiting = false;
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx');
      try {
        writeSync(fd, JSON.stringify(record));
      } finally {
        closeSync(fd);
      }
      return token;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    const stale = staleLockToken(lockPath, probe);
    if (stale !== null) {
      removeStaleLock(lockPath, stale);
      continue;
    }
    if (!waiting) {
      waiting = true;
      onWait();
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

function refreshLock(lockPath: string, token: string): void {
  if (readLock(lockPath)?.token !== token) return;
  try {
    const now = new Date();
    utimesSync(lockPath, now, now);
  } catch {
    // Released meanwhile.
  }
}

function releaseLock(lockPath: string, token: string): void {
  if (readLock(lockPath)?.token === token) rmSync(lockPath, { force: true });
}

export function markInUse(runtimeRoot: string, name: string, record: ProcessRecord): void {
  const dir = join(runtimeRoot, IN_USE_DIR, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, String(record.pid)), `${JSON.stringify(record)}\n`);
}

export function releaseInUse(runtimeRoot: string, name: string, pid: number = process.pid): void {
  const dir = join(runtimeRoot, IN_USE_DIR, name);
  rmSync(join(dir, String(pid)), { force: true });
  removeIfEmpty(dir);
}

/** Whether a live process uses the runtime. Drops the records of dead ones. */
function hasLiveUsers(runtimeRoot: string, name: string, probe: ProcessProbe): boolean {
  const dir = join(runtimeRoot, IN_USE_DIR, name);
  if (!existsSync(dir)) return false;
  let live = false;
  for (const file of readdirSync(dir)) {
    let record: ProcessRecord | null = null;
    try {
      const parsed = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Partial<ProcessRecord>;
      if (typeof parsed.pid === 'number' && typeof parsed.bootTime === 'number') {
        record = { pid: parsed.pid, bootTime: parsed.bootTime };
      }
    } catch {
      // Unreadable: treat as dead.
    }
    if (record && isLive(record, probe)) live = true;
    else rmSync(join(dir, file), { force: true });
  }
  if (!live) removeIfEmpty(dir);
  return live;
}

function removeIfEmpty(dir: string): void {
  try {
    rmdirSync(dir);
  } catch {
    // Not empty or gone.
  }
}

function trashPath(runtimeRoot: string, name: string): string {
  return join(
    runtimeRoot,
    `${TRASH_PREFIX}${name}-${Date.now()}-${randomBytes(4).toString('hex')}`,
  );
}

function readFamily(runtimeDir: string): string | null {
  try {
    const marker = JSON.parse(readFileSync(join(runtimeDir, COMPLETE_MARKER), 'utf8')) as {
      family?: unknown;
    };
    return typeof marker.family === 'string' ? marker.family : null;
  } catch {
    return null;
  }
}

/** When a launch last used the runtime, falling back to file times. */
function lastUsedAt(runtimeDir: string): number {
  try {
    const value = Number.parseInt(readFileSync(join(runtimeDir, LAST_USED), 'utf8'), 10);
    if (Number.isFinite(value)) return value;
  } catch {
    // Older runtime.
  }
  for (const path of [join(runtimeDir, COMPLETE_MARKER), runtimeDir]) {
    try {
      return statSync(path).mtimeMs;
    } catch {
      // Try the next one.
    }
  }
  return 0;
}

export interface CleanupOptions {
  readonly runtimeRoot: string;
  /** The runtime this process uses. */
  readonly keep: string;
  /** Its family, see `MaterializeOptions.family`. */
  readonly family: string;
  readonly maxUnusedMs?: number;
  readonly probe?: ProcessProbe;
}

/**
 * Deletes runtimes no live process uses or builds that are either replaced
 * by `keep` (same family) or unused for `maxUnusedMs`. Also removes staging
 * directories and locks left by dead processes. Returns the deleted runtimes.
 */
export function cleanStaleRuntimes(options: CleanupOptions): string[] {
  const { runtimeRoot, keep, family } = options;
  const probe = options.probe ?? systemProbe();
  const maxUnusedMs = options.maxUnusedMs ?? DEFAULT_MAX_UNUSED_MS;
  if (!existsSync(runtimeRoot)) return [];
  const removed: string[] = [];

  for (const entry of readdirSync(runtimeRoot)) {
    const path = join(runtimeRoot, entry);
    if (entry.startsWith(TRASH_PREFIX)) {
      const stamp = Number.parseInt(entry.split('-').at(-2) ?? '', 10);
      if (probe.now() - stamp > TRASH_STALE_MS) rmSync(path, { recursive: true, force: true });
    } else if (entry.startsWith(RUNTIME_PREFIX) && entry.endsWith('.lock')) {
      const stale = staleLockToken(path, probe);
      if (stale !== null) removeStaleLock(path, stale);
    } else if (entry.startsWith(STAGING_PREFIX)) {
      // Staging only exists while its builder holds the runtime's lock.
      const runtime = entry.slice(STAGING_PREFIX.length, entry.lastIndexOf('-'));
      if (!isLockLive(join(runtimeRoot, `${runtime}.lock`), probe)) {
        rmSync(path, { recursive: true, force: true });
      }
    } else if (entry === IN_USE_DIR) {
      for (const name of readdirSync(path)) {
        if (!existsSync(join(runtimeRoot, name))) hasLiveUsers(runtimeRoot, name, probe);
      }
    } else if (entry.startsWith(RUNTIME_PREFIX) && entry !== keep) {
      if (deleteIfStale(runtimeRoot, entry, family, maxUnusedMs, probe)) removed.push(entry);
    }
  }
  hasLiveUsers(runtimeRoot, keep, probe); // drops dead users of the kept runtime
  return removed;
}

function deleteIfStale(
  runtimeRoot: string,
  name: string,
  family: string,
  maxUnusedMs: number,
  probe: ProcessProbe,
): boolean {
  const path = join(runtimeRoot, name);
  if (!statSync(path).isDirectory()) return false;
  if (isLockLive(join(runtimeRoot, `${name}.lock`), probe)) return false;
  if (hasLiveUsers(runtimeRoot, name, probe)) return false;
  const replaced = readFamily(path) === family;
  const expired = probe.now() - lastUsedAt(path) > maxUnusedMs;
  if (!replaced && !expired) return false;

  // Move it out of the way first, then look for users again: a process that
  // registered in between gets its runtime back before it starts using it.
  const trash = trashPath(runtimeRoot, name);
  try {
    renameSync(path, trash);
  } catch {
    return false;
  }
  if (hasLiveUsers(runtimeRoot, name, probe)) {
    try {
      renameSync(trash, path);
    } catch {
      // It rebuilds the runtime.
    }
    return false;
  }
  rmSync(trash, { recursive: true, force: true });
  return true;
}
