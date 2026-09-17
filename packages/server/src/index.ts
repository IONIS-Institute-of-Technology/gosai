/**
 * Server entry point. Reads the environment, works out where the Python
 * project, the built-in apps and the SDK bundle live, and starts the server.
 * Every path the server uses is resolved here.
 */

import { dirname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { generateDashboardToken } from '@gosai/shared/auth';
import { loadGlobalConfig } from './config/config.js';
import { defaultPaths } from './paths.js';
import { createServer } from './server.js';

const paths = defaultPaths();
const layout = installLayout();

const host = process.env.GOSAI_HOST ?? '127.0.0.1';
const port = process.env.GOSAI_PORT
  ? Number.parseInt(process.env.GOSAI_PORT, 10)
  : loadGlobalConfig(paths.config).config.serverPort;

// Desktop main passes the token it generated. A standalone server makes its
// own. The variable stays set because `bun --hot` re-runs this file in the
// same process; the Python bridge and the installer strip it from the
// environment of the processes they spawn.
const providedToken = process.env.GOSAI_DASHBOARD_TOKEN;
const dashboardToken = providedToken || generateDashboardToken();
process.env.GOSAI_DASHBOARD_TOKEN = dashboardToken;

const builtinAppsDir = envPath('GOSAI_BUILTIN_APPS') ?? layout.builtinApps;

const server = await createServer({
  host,
  port,
  paths,
  pythonDir: envPath('GOSAI_PYTHON_DIR') ?? layout.python,
  uv: envPath('GOSAI_UV') ?? layout.uv,
  ...(process.env.GOSAI_UV_CACHE_DIR
    ? { uvCacheDir: resolve(process.env.GOSAI_UV_CACHE_DIR) }
    : {}),
  ...(existsSync(builtinAppsDir) ? { builtinAppsDir } : {}),
  sdkDir: envPath('GOSAI_SDK_DIR') ?? layout.sdkDir,
  enablePython: process.env.GOSAI_PYTHON !== '0',
  dashboardToken,
  allowedOrigins: listEnv('GOSAI_ALLOWED_ORIGINS'),
  allowedHosts: listEnv('GOSAI_ALLOWED_HOSTS'),
});

if (!providedToken) {
  console.log(
    `GOSAI_DASHBOARD_TOKEN=${dashboardToken} (generated for this run; ` +
      'set GOSAI_DASHBOARD_TOKEN to choose one)',
  );
}

// Machine-readable readiness signal. GOSAI_PORT=0 asks the OS for a free
// ephemeral port, so supervisors (the Electron shell) read the actual port
// from this line.
console.log(`GOSAI_READY ${JSON.stringify({ port: server.port, host, pid: process.pid })}`);

let stopping = false;
const shutdown = async (reason: string): Promise<void> => {
  if (stopping) return;
  stopping = true;
  console.log(`[gosai-server] shutting down (${reason})`);
  await server.stop();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

// The desktop app keeps a pipe to our stdin and sets this variable. The pipe
// closes when Electron exits for any reason, including a crash or SIGKILL, so
// the server stops the Python bridge and exits instead of holding its port.
// Unlike process groups, this also works on Windows.
if (process.env.GOSAI_EXIT_ON_STDIN_CLOSE === '1') {
  process.stdin.on('end', () => void shutdown('stdin closed'));
  process.stdin.on('close', () => void shutdown('stdin closed'));
  process.stdin.resume();
}

interface InstallLayout {
  readonly python: string;
  /** uv for app Python environments: the bundled binary, or `uv` on PATH from source. */
  readonly uv: string;
  readonly builtinApps: string;
  /** The built SDK: `index.js`, `host.js`, `app-host.js` and their chunks. */
  readonly sdkDir: string;
}

/**
 * Default locations. From source they are in the repository. A binary built
 * with `bun build --compile` has no source tree (`import.meta.dir` points into
 * the embedded filesystem), so they are found next to the binary instead:
 * packaged apps put it at `<resources>/server/gosai-server`, beside
 * `<resources>/python`, `<resources>/apps`, `<resources>/sdk` and
 * `<resources>/bin/uv`.
 */
function installLayout(): InstallLayout {
  const compiled =
    import.meta.dir.startsWith('/$bunfs') || /^[A-Z]:\\~BUN\\/i.test(import.meta.dir);
  if (compiled) {
    const resources = dirname(dirname(process.execPath));
    return {
      python: join(resources, 'python'),
      uv: join(resources, 'bin', process.platform === 'win32' ? 'uv.exe' : 'uv'),
      builtinApps: join(resources, 'apps'),
      sdkDir: join(resources, 'sdk'),
    };
  }
  const repo = resolve(import.meta.dir, '..', '..', '..');
  return {
    python: join(repo, 'python'),
    uv: 'uv',
    builtinApps: join(repo, 'apps'),
    sdkDir: join(repo, 'packages', 'sdk', 'dist'),
  };
}

function envPath(name: string): string | undefined {
  const value = process.env[name];
  return value ? resolve(value) : undefined;
}

function listEnv(name: string): string[] {
  return (process.env[name] ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}
