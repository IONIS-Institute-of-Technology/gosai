/**
 * First-run Python runtime bootstrap for packaged builds.
 *
 * Packaged bundles (regular desktop and kiosks) ship the Python source tree
 * and a `uv` binary under the read-only resources directory. Because a venv
 * cannot be created there (AppImages are read-only mounts), the tree is
 * copied on first launch to a writable, content-addressed runtime directory:
 *
 *   ~/.gosai-runtime/python-<hash>/python/        the tree + .venv
 *   ~/.gosai-runtime/python-<hash>/cpython/       uv-managed interpreters
 *
 * `uv sync` then materialises the venv, downloading a managed CPython 3.12
 * if the machine has none - so the CV drivers (camera, pose, hand_pose,
 * ball, ...) work out of the box on a clean machine. The hash covers
 * pyproject.toml, uv.lock, and the requested extras, so kiosks with the same
 * requirements share one runtime and upgrades rebuild cleanly. Needs network
 * on the very first launch only.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { app } from 'electron';

export interface PythonBootstrapOptions {
  /** Optional dependency extras to install (e.g. ["speech", "realsense"]). */
  readonly extras?: string[];
  /** Progress callback; only invoked when an actual installation runs. */
  readonly onStatus?: (message: string) => void;
}

/**
 * Returns the python directory the server should use, or null when the
 * default resolution is fine (dev mode). Throws when a required first-run
 * installation fails.
 */
export async function ensurePythonRuntime(
  options: PythonBootstrapOptions = {},
): Promise<string | null> {
  if (!app.isPackaged) return null;

  const resourcesPython = join(process.resourcesPath, 'python');
  if (!existsSync(join(resourcesPython, 'pyproject.toml'))) {
    console.warn('[gosai-python] no python tree in resources; skipping bootstrap');
    return null;
  }

  const extras = [...new Set(options.extras ?? [])].sort();
  const hash = runtimeHash(resourcesPython, extras);
  const runtimeDir = join(homedir(), '.gosai-runtime', `python-${hash}`);
  const pythonDir = join(runtimeDir, 'python');

  if (hasBridge(pythonDir)) return pythonDir;

  const onStatus = options.onStatus ?? (() => undefined);
  onStatus('Preparing the Python runtime (first launch)…');
  console.log(`[gosai-python] materialising runtime at ${runtimeDir}`);

  // Re-copy from scratch so a previously interrupted attempt cannot leave a
  // half-populated tree behind.
  rmSync(pythonDir, { recursive: true, force: true });
  mkdirSync(runtimeDir, { recursive: true });
  cpSync(resourcesPython, pythonDir, {
    recursive: true,
    filter: (src) => {
      const name = basename(src);
      return name !== '.venv' && name !== '__pycache__' && name !== '.pytest_cache';
    },
  });

  const uv = resolveUv();
  const args = ['sync', '--frozen', '--python', '3.12', ...extras.flatMap((e) => ['--extra', e])];
  onStatus('Installing Python and the CV driver dependencies…');
  await runUv(uv, args, pythonDir, join(runtimeDir, 'cpython'), onStatus);

  if (!hasBridge(pythonDir)) {
    throw new Error('uv sync completed but the gosai-bridge entry point is missing');
  }
  onStatus('Python runtime ready.');
  console.log('[gosai-python] runtime ready');
  return pythonDir;
}

function hasBridge(pythonDir: string): boolean {
  return existsSync(join(pythonDir, '.venv', 'bin', 'gosai-bridge'));
}

function runtimeHash(resourcesPython: string, extras: string[]): string {
  const hash = createHash('sha256');
  for (const file of ['pyproject.toml', 'uv.lock']) {
    const path = join(resourcesPython, file);
    if (existsSync(path)) hash.update(readFileSync(path));
  }
  hash.update(extras.join(','));
  return hash.digest('hex').slice(0, 12);
}

function resolveUv(): string {
  const binDir = join(process.resourcesPath, 'bin');
  for (const candidate of [join(binDir, 'uv'), join(binDir, `uv-${process.arch}`)]) {
    if (existsSync(candidate)) return candidate;
  }
  // Last resort: a uv already installed on the machine.
  return 'uv';
}

function runUv(
  uv: string,
  args: string[],
  cwd: string,
  pythonInstallDir: string,
  onStatus: (message: string) => void,
): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    console.log(`[gosai-python] $ ${uv} ${args.join(' ')}`);
    const child = spawn(uv, args, {
      cwd,
      env: {
        ...process.env,
        UV_PYTHON_INSTALL_DIR: pythonInstallDir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const forward = (chunk: Buffer): void => {
      const text = chunk.toString('utf8');
      process.stdout.write(text);
      const line = text
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .pop();
      if (line) onStatus(line);
    };
    child.stdout.on('data', forward);
    child.stderr.on('data', forward);

    child.on('error', (err) => {
      rejectPromise(
        new Error(
          `could not run uv (${String(err)}). The bundle should ship it under resources/bin.`,
        ),
      );
    });
    child.on('exit', (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`uv sync failed with exit code ${code}`));
    });
  });
}
