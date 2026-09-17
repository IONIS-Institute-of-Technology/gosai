/**
 * First-launch Python runtime of packaged builds (regular desktop and
 * kiosks). See python-runtime.ts for the layout. `uv` ships in the bundle
 * under resources/bin and installs a managed CPython when the machine has
 * none, so the drivers work on a clean machine. Linux x64 machines with an
 * NVIDIA driver 580 or newer also get the `gpu` extra. Needs network on the
 * first launch only.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { app } from 'electron';
import { currentPythonHost, pythonExtras, uvSyncArgs } from './python-extras.js';
import {
  cleanStaleRuntimes,
  materializeRuntime,
  readPythonRuntimeInfo,
  releaseInUse,
  runtimeName,
} from './python-runtime.js';

export interface PythonBootstrapOptions {
  /** Optional dependency extras to install (e.g. ["speech", "realsense"]). `gpu` is added automatically. */
  readonly extras?: readonly string[];
  /** Progress messages for the splash window. */
  readonly onStatus?: (message: string) => void;
}

/**
 * Returns the python directory the server should use, or null when running
 * from source, where the server finds the repository's python/ itself.
 * Throws when the runtime can't be installed.
 */
export async function ensurePythonRuntime(
  options: PythonBootstrapOptions = {},
): Promise<string | null> {
  if (!app.isPackaged) return null;

  const resources = process.resourcesPath;
  const sourceDir = join(resources, 'python');
  if (!existsSync(join(sourceDir, 'pyproject.toml'))) {
    throw new Error(`the bundle has no Python tree at ${sourceDir}`);
  }
  const info = readPythonRuntimeInfo(join(resources, 'python-runtime.json'));
  const { extras, gpuReason } = pythonExtras(options.extras ?? [], currentPythonHost());
  if (gpuReason) console.log(`[gosai-python] ${gpuReason}`);

  const runtimeRoot = join(homedir(), '.gosai-runtime');
  const name = runtimeName(info, extras);
  const uv = bundledUv(resources);
  const onStatus = options.onStatus ?? (() => undefined);
  // Upgrades of this app with these extras replace each other's runtime.
  const family = `${app.getName()}\n${extras.join(',')}`;
  const pythonDir = await materializeRuntime({
    sourceDir,
    runtimeRoot,
    name,
    family,
    commands: [
      // Relocatable, so the staged runtime still works after the rename.
      ['venv', '--relocatable', '--python', info.python, '.venv'],
      ...uvSyncArgs(extras, info.python),
    ],
    runUv: (args, cwd) => runUv(uv, args, cwd, join(runtimeRoot, 'cpython'), onStatus),
    onStatus,
  });
  console.log(`[gosai-python] using ${pythonDir}`);

  // Best effort: cleanup also ignores users whose process is gone.
  process.once('exit', () => releaseInUse(runtimeRoot, name));
  try {
    for (const removed of cleanStaleRuntimes({ runtimeRoot, keep: name, family })) {
      console.log(`[gosai-python] removed the unused runtime ${removed}`);
    }
  } catch (err) {
    console.warn(`[gosai-python] could not remove old runtimes: ${String(err)}`);
  }
  return pythonDir;
}

function bundledUv(resources: string): string {
  const uv = join(resources, 'bin', process.platform === 'win32' ? 'uv.exe' : 'uv');
  if (!existsSync(uv)) throw new Error(`the bundle is missing uv at ${uv}`);
  return uv;
}

function runUv(
  uv: string,
  args: readonly string[],
  cwd: string,
  pythonInstallDir: string,
  onStatus: (message: string) => void,
): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    console.log(`[gosai-python] $ uv ${args.join(' ')}`);
    const child = spawn(uv, args, {
      cwd,
      env: { ...process.env, UV_PYTHON_INSTALL_DIR: pythonInstallDir },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let lastLine = '';
    const forward = (chunk: Buffer): void => {
      const text = chunk.toString('utf8');
      process.stdout.write(text);
      const line = text
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .pop();
      if (line) {
        lastLine = line;
        onStatus(line);
      }
    };
    child.stdout.on('data', forward);
    child.stderr.on('data', forward);

    child.on('error', (err) => rejectPromise(new Error(`could not run uv: ${String(err)}`)));
    child.on('exit', (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`uv ${args[0]} failed with exit code ${code}: ${lastLine}`));
    });
  });
}
