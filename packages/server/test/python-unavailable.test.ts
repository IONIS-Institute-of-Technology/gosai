/**
 * A server without a usable Python environment: the reason reaches driver
 * calls, experience starts and the dashboard's `system:stats`.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import type { SystemStats } from '@gosai/shared';
import { mintAppToken } from '@gosai/shared/auth';
import { ServerClient } from '@gosai/shared/client';
import { createServer, type GosaiServer, type ServerOptions } from '../src/server.js';

const SECRET = 'python-unavailable-token';

const servers: GosaiServer[] = [];
const clients: ServerClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  await Promise.all(servers.splice(0).map((server) => server.stop()));
});

function makePaths(): ServerOptions['paths'] {
  const tmp = mkdtempSync(join(tmpdir(), 'gosai-python-unavailable-'));
  const paths = {
    root: tmp,
    apps: join(tmp, 'apps'),
    logs: join(tmp, 'logs'),
    data: join(tmp, 'data'),
    config: join(tmp, 'config'),
  };
  for (const dir of Object.values(paths)) mkdirSync(dir, { recursive: true });
  mkdirSync(join(paths.apps, 'pool'));
  writeFileSync(
    join(paths.apps, 'pool', 'gosai.app.json'),
    JSON.stringify({
      slug: 'pool',
      name: 'Pool',
      version: '1.0.0',
      experiences: [{ slug: 'main', name: 'Main', entry: 'main.js', drivers: ['pose'] }],
    }),
  );
  return paths;
}

async function start(options: Partial<ServerOptions> = {}): Promise<GosaiServer> {
  const server = await createServer({
    host: '127.0.0.1',
    port: 0,
    paths: makePaths(),
    dashboardToken: SECRET,
    ...options,
  });
  servers.push(server);
  return server;
}

async function connect(server: GosaiServer, token: string): Promise<ServerClient> {
  const client = new ServerClient({ url: `ws://127.0.0.1:${server.port}/ws`, token });
  clients.push(client);
  client.connect();
  await client.ready();
  return client;
}

describe('Python drivers unavailable', () => {
  test('a missing environment fails driver calls with a way to fix it', async () => {
    const pythonDir = mkdtempSync(join(tmpdir(), 'gosai-no-venv-'));
    const server = await start({ pythonDir });
    const reason = `there is no Python environment at ${join(pythonDir, '.venv')}; run \`uv sync\` in ${pythonDir}`;
    const message = `Python drivers are unavailable: ${reason}`;
    expect(server.drivers.unavailableReason()).toBe(reason);

    const app = await connect(server, mintAppToken(SECRET, 'pool'));
    const pose = { binding: 'pool', driver: 'pose' };
    await expect(app.request('driver:subscribe', { ...pose, event: '*' })).rejects.toThrow(message);
    await expect(app.request('driver:execute', { ...pose, action: 'reset' })).rejects.toThrow(
      message,
    );
    await expect(app.request('driver:get-data', { ...pose, event: 'landmarks' })).rejects.toThrow(
      message,
    );
    await expect(app.request('drivers:schema', { driver: 'pose' })).rejects.toThrow(message);
    await expect(
      app.request('experience:start', { appSlug: 'pool', experienceSlug: 'main' }),
    ).rejects.toThrow(message);
  });

  test('the dashboard gets the reason with the system stats', async () => {
    const server = await start({ pythonSetupError: 'uv sync failed with exit code 2: offline' });
    const dashboard = await connect(server, SECRET);
    const stats = await new Promise<SystemStats>((resolve) => {
      dashboard.on('system:stats', resolve);
    });
    expect(stats.pythonUnavailable).toBe(
      'the Python runtime could not be installed: uv sync failed with exit code 2: offline',
    );
  });

  test('says when Python is disabled', async () => {
    const server = await start({ enablePython: false, pythonDir: '/does/not/matter' });
    expect(server.drivers.unavailableReason()).toBe('Python is disabled (GOSAI_PYTHON=0)');
  });
});
