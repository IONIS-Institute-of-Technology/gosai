/// <reference types="node" />
/**
 * Where a Python project's virtual environment keeps the driver bridge. The
 * server runs it, and the desktop app checks for it after installing the
 * Python runtime.
 *
 * Uses `node:path`, so only Node, Bun and Electron main import this module.
 */

import { join } from 'node:path';

/** The venv's `gosai-bridge` entry point. Windows venvs use `Scripts` and `.exe`. */
export function bridgeExecutable(
  pythonDir: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === 'win32'
    ? join(pythonDir, '.venv', 'Scripts', 'gosai-bridge.exe')
    : join(pythonDir, '.venv', 'bin', 'gosai-bridge');
}
