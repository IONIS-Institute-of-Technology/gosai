import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { createServer, type ServerOptions } from './server.js';
import { defaultPaths, type GosaiPaths } from './paths.js';

const port = Number.parseInt(process.env.GOSAI_PORT ?? '7777', 10);
const host = process.env.GOSAI_HOST ?? '127.0.0.1';

const paths: GosaiPaths = defaultPaths();
const pythonDir = resolvePythonDir();
const builtinAppsDir = resolveBuiltinAppsDir();

const enablePython = process.env.GOSAI_PYTHON !== '0';

const options: ServerOptions = {
  host,
  port,
  paths,
  pythonDir,
  ...(builtinAppsDir ? { builtinAppsDir } : {}),
  enablePython,
};

const server = await createServer(options);

const shutdown = async (signal: string): Promise<void> => {
  await server.stop();
  process.exit(0);
  void signal;
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

function resolvePythonDir(): string {
  if (process.env.GOSAI_PYTHON_DIR) return resolve(process.env.GOSAI_PYTHON_DIR);
  return resolve(import.meta.dir, '..', '..', '..', 'python');
}

function resolveBuiltinAppsDir(): string | undefined {
  if (process.env.GOSAI_BUILTIN_APPS) {
    const path = resolve(process.env.GOSAI_BUILTIN_APPS);
    return existsSync(path) ? path : undefined;
  }
  const guess = resolve(import.meta.dir, '..', '..', '..', 'apps');
  return existsSync(guess) ? guess : undefined;
}
