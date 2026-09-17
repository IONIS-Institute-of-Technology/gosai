/**
 * Runs an app's drivers with Python: prepares the app's environment (see
 * apps/python-env.ts) and starts `python -m gosai_py.bridge --app-drivers` in
 * it. The process gets the app's slug, directory and data directory in
 * `GOSAI_APP_SLUG`, `GOSAI_APP_DIR` and `GOSAI_APP_DATA_DIR`, and writes
 * bytecode into the environment rather than into the app directory, which may
 * be inside a signed application bundle.
 */

import {
  appEnvPython,
  appPycacheDir,
  appPythonEnvDir,
  ensureAppPythonEnv,
  resolveAppPath,
  type PythonToolchain,
} from '../apps/python-env.js';
import type { Logger } from '../logger/logger.js';
import { appDataDir, type GosaiPaths } from '../paths.js';
import { PythonBridge } from './bridge.js';
import type { AppBridgeProvider, AppDriverSource } from './hub.js';

export interface PythonAppBridgesOptions {
  readonly toolchain: PythonToolchain;
  readonly paths: Pick<GosaiPaths, 'root' | 'data'>;
  readonly logger: Logger;
  /** How long a first environment build may take. */
  readonly timeoutMs?: number;
}

/** Variables the bridge of `app`'s drivers gets, besides the server's own. */
export function appBridgeEnv(
  app: AppDriverSource,
  envDir: string,
  paths: Pick<GosaiPaths, 'data'>,
): Record<string, string> {
  return {
    GOSAI_APP_SLUG: app.slug,
    GOSAI_APP_DIR: app.installPath,
    GOSAI_APP_DATA_DIR: appDataDir(paths, app.slug),
    PYTHONPYCACHEPREFIX: appPycacheDir(envDir),
  };
}

export function pythonAppBridges(options: PythonAppBridgesOptions): AppBridgeProvider {
  const envDir = (app: AppDriverSource): string =>
    appPythonEnvDir(options.paths, app.builtin ? 'builtin' : 'installed', app.slug);

  return {
    async prepare(app, signal) {
      await ensureAppPythonEnv({
        signal,
        toolchain: options.toolchain,
        envDir: envDir(app),
        appDir: app.installPath,
        python: app.python,
        logger: options.logger.child(`python-env:${app.slug}`),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      });
    },

    createBridge(app, handlers) {
      return new PythonBridge({
        // -P keeps the working directory off sys.path.
        command: [
          appEnvPython(envDir(app)),
          '-P',
          '-m',
          'gosai_py.bridge',
          '--app-drivers',
          resolveAppPath(app.installPath, app.python.drivers),
        ],
        cwd: app.installPath,
        env: appBridgeEnv(app, envDir(app), options.paths),
        logger: options.logger.child(`drivers:${app.slug}`),
        handlers,
      });
    },
  };
}
