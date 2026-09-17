import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'bun:test';
import { mintAppToken } from '@gosai/shared/auth';
import { ServerClient } from '@gosai/shared/client';
import { createServer, type GosaiServer } from '../src/server.js';

const SECRET = 'reconnect-dashboard-token';

const tmp = mkdtempSync(join(tmpdir(), 'gosai-reconnect-'));
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
    experiences: [{ slug: 'main', name: 'Main', entry: 'main.js' }],
  }),
);

const start = (port: number): Promise<GosaiServer> =>
  createServer({ host: '127.0.0.1', port, paths, enablePython: false, dashboardToken: SECRET });

const clients: ServerClient[] = [];
let server: GosaiServer | null = null;

afterAll(async () => {
  for (const client of clients) client.close();
  await server?.stop();
});

function connect(token: string): ServerClient {
  const client = new ServerClient({
    url: `ws://127.0.0.1:${server!.port}/ws`,
    token,
    reconnectDelayMs: 10,
    maxReconnectDelayMs: 50,
  });
  clients.push(client);
  client.connect();
  return client;
}

describe('ServerClient against the server', () => {
  test('reconnects after a restart, resubscribes, and delivers each event once', async () => {
    server = await start(0);
    const port = server.port;
    const window = connect(mintAppToken(SECRET, 'pool'));
    const dashboard = connect(SECRET);
    await Promise.all([window.ready(), dashboard.ready()]);

    const received: unknown[] = [];
    window.on('app:pool:step', (payload) => received.push(payload));
    window.on('app:pool:step', () => undefined);
    await window.request('system:ping');
    await dashboard.request('app:broadcast', { appSlug: 'pool', topic: 'step', data: 1 });
    await window.request('system:ping');
    expect(received).toEqual([1]);

    const dropped = (client: ServerClient): Promise<void> =>
      new Promise((resolve) => client.onStatus((status) => status !== 'connected' && resolve()));
    const bothDropped = Promise.all([dropped(window), dropped(dashboard)]);
    await server.stop();
    await bothDropped;
    server = await start(port);
    await Promise.all([window.ready(5000), dashboard.ready(5000)]);

    // The resubscribe batch went out before this round trip.
    await window.request('system:ping');
    await dashboard.request('app:broadcast', { appSlug: 'pool', topic: 'step', data: 2 });
    await window.request('system:ping');
    expect(received).toEqual([1, 2]);
  });

  test('typed requests round-trip through validation and capabilities', async () => {
    server ??= await start(0);
    const window = connect(mintAppToken(SECRET, 'pool'));
    await window.ready();
    await window.request('storage:set', { appSlug: 'pool', key: 'score', value: 5 });
    expect(await window.request('storage:get', { appSlug: 'pool', key: 'score' })).toEqual({
      found: true,
      value: 5,
    });
    await expect(window.request('config:set', { displayId: 1 })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(window.serverInfo?.capabilities).toContain('storage:write');
  });
});
