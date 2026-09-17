import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mintAppToken } from '@gosai/shared/auth';
import { createServer, type GosaiServer } from '../src/server.js';

const SECRET = 'test-dashboard-token';
const POOL_TOKEN = mintAppToken(SECRET, 'pool');

let server: GosaiServer;
let base: string;

function writeApp(dir: string, slug: string): void {
  mkdirSync(join(dir, 'dist'), { recursive: true });
  writeFileSync(
    join(dir, 'gosai.app.json'),
    JSON.stringify({
      slug,
      name: slug,
      version: '0.0.0',
      experiences: [{ slug: 'main', name: 'Main', entry: 'dist/main.js' }],
    }),
  );
  writeFileSync(join(dir, 'dist', 'main.js'), `export const slug = '${slug}';`);
}

beforeAll(async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'gosai-server-access-'));
  const paths = {
    root: tmp,
    apps: join(tmp, 'apps'),
    logs: join(tmp, 'logs'),
    data: join(tmp, 'data'),
    config: join(tmp, 'config'),
  };
  for (const dir of Object.values(paths)) mkdirSync(dir, { recursive: true });
  const builtin = join(tmp, 'builtin');
  writeApp(join(builtin, 'pool'), 'pool');
  // Installed apps keep storage and settings inside their install directory.
  writeApp(join(paths.apps, 'other'), 'other');
  writeFileSync(join(tmp, 'outside.txt'), 'outside');
  symlinkSync(join(tmp, 'outside.txt'), join(builtin, 'pool', 'dist', 'leak.txt'));

  server = await createServer({
    host: '127.0.0.1',
    port: 0,
    paths,
    builtinAppsDir: builtin,
    enablePython: false,
    dashboardToken: SECRET,
    allowedOrigins: ['null'],
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.stop();
});

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

describe('HTTP access', () => {
  test('health needs no token, /v1 routes do', async () => {
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect((await fetch(`${base}/v1/info`)).status).toBe(401);
    expect((await fetch(`${base}/v1/info`, { headers: bearer('wrong') })).status).toBe(401);
    expect((await fetch(`${base}/v1/apps`, { headers: bearer(POOL_TOKEN) })).status).toBe(200);
  });

  test('/v1/info does not expose filesystem paths', async () => {
    const info = (await (
      await fetch(`${base}/v1/info`, { headers: bearer(SECRET) })
    ).json()) as Record<string, unknown>;
    expect(info.protocolVersion).toBeDefined();
    expect(info).not.toHaveProperty('paths');
  });

  test('rejects foreign Host and Origin headers', async () => {
    const rebinding = await fetch(`${base}/healthz`, {
      headers: { host: `evil.example:${server.port}` },
    });
    expect(rebinding.status).toBe(403);
    const foreign = await fetch(`${base}/v1/info`, {
      headers: { ...bearer(SECRET), origin: 'https://evil.example' },
    });
    expect(foreign.status).toBe(403);
  });

  test('reflects allowed origins instead of a wildcard', async () => {
    const res = await fetch(`${base}/v1/info`, { headers: { ...bearer(SECRET), origin: 'null' } });
    expect(res.headers.get('access-control-allow-origin')).toBe('null');
    const preflight = await fetch(`${base}/v1/apps/pool/storage/key`, {
      method: 'OPTIONS',
      headers: { origin: 'http://localhost:5173' },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect(preflight.headers.get('access-control-allow-headers')).toContain('Authorization');
    const plain = await fetch(`${base}/healthz`);
    expect(plain.headers.get('access-control-allow-origin')).toBeNull();
  });

  test('app tokens only reach their own storage', async () => {
    const write = await fetch(`${base}/v1/apps/pool/storage/score`, {
      method: 'POST',
      headers: { ...bearer(POOL_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify(3),
    });
    expect(write.status).toBe(200);
    const read = await fetch(`${base}/v1/apps/pool/storage/score`, { headers: bearer(POOL_TOKEN) });
    expect(await read.json()).toBe(3);

    const otherRead = await fetch(`${base}/v1/apps/other/storage/score`, {
      headers: bearer(POOL_TOKEN),
    });
    expect(otherRead.status).toBe(403);
    const otherList = await fetch(`${base}/v1/apps/other/storage`, { headers: bearer(POOL_TOKEN) });
    expect(otherList.status).toBe(403);
    const dashboardRead = await fetch(`${base}/v1/apps/pool/storage/score`, {
      headers: bearer(SECRET),
    });
    expect(await dashboardRead.json()).toBe(3);
  });

  test("static route doesn't serve app storage, settings or dot files", async () => {
    const write = await fetch(`${base}/v1/apps/other/storage/secret`, {
      method: 'POST',
      headers: { ...bearer(SECRET), 'content-type': 'application/json' },
      body: JSON.stringify('hidden'),
    });
    expect(write.status).toBe(200);
    const code = await fetch(`${base}/v1/apps/other/static/dist/main.js`);
    expect(code.status).toBe(200);

    for (const path of [
      '_data/storage/secret.json',
      '_DATA/storage/secret.json',
      'dist/..%2F_data/storage/secret.json',
      '_config/settings.json',
      'gosai.app.json/../_data/storage/secret.json',
    ]) {
      for (const headers of [{}, bearer(POOL_TOKEN), { origin: 'null' }]) {
        const res = await fetch(`${base}/v1/apps/other/static/${path}`, { headers });
        expect(res.status).not.toBe(200);
        expect(await res.text()).not.toContain('hidden');
      }
    }
  });

  test("app tokens can't start or stop another app's experiences over HTTP", async () => {
    for (const action of ['start', 'stop']) {
      const res = await fetch(`${base}/v1/experiences/${action}`, {
        method: 'POST',
        headers: { ...bearer(POOL_TOKEN), 'content-type': 'application/json' },
        body: JSON.stringify({ appSlug: 'other', experienceSlug: 'main' }),
      });
      expect(res.status).toBe(403);
    }
    const own = await fetch(`${base}/v1/experiences/stop`, {
      method: 'POST',
      headers: { ...bearer(POOL_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify({ appSlug: 'pool', experienceSlug: 'main' }),
    });
    expect(own.status).toBe(200);
  });

  test('rejects invalid slugs in routes', async () => {
    const res = await fetch(`${base}/v1/apps/Bad_Slug/storage/key`, { headers: bearer(SECRET) });
    expect(res.status).toBe(400);
    const start = await fetch(`${base}/v1/experiences/start`, {
      method: 'POST',
      headers: { ...bearer(SECRET), 'content-type': 'application/json' },
      body: JSON.stringify({ appSlug: '../pool', experienceSlug: 'main' }),
    });
    expect(start.status).toBe(400);
  });

  test('static route serves app files and blocks traversal and symlink escapes', async () => {
    const ok = await fetch(`${base}/v1/apps/pool/static/dist/main.js`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain("'pool'");
    for (const path of [
      'dist/leak.txt',
      '..%2F..%2Foutside.txt',
      '%2e%2e/%2e%2e/outside.txt',
      'dist/..%2F..%2F..%2Foutside.txt',
    ]) {
      const res = await fetch(`${base}/v1/apps/pool/static/${path}`);
      // Dot segments that the URL parser collapses leave the static route and
      // hit the token check instead.
      expect([401, 404]).toContain(res.status);
      expect(await res.text()).not.toContain('outside');
    }
  });
});

interface CommandResponse {
  readonly ok: boolean;
  readonly data?: unknown;
  readonly error?: { code: string; message: string };
}

async function connect(token: string | null): Promise<{
  request(type: string, payload?: unknown): Promise<CommandResponse>;
  close(): void;
}> {
  const url =
    token === null
      ? `${base.replace('http', 'ws')}/ws`
      : `${base.replace('http', 'ws')}/ws?token=${encodeURIComponent(token)}`;
  const ws = new WebSocket(url);
  const pending = new Map<string, (res: CommandResponse) => void>();
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data)) as {
        type: string;
        payload: CommandResponse & { requestId: string };
      };
      if (msg.type === 'server:welcome') resolve();
      if (msg.type === 'response') pending.get(msg.payload.requestId)?.(msg.payload);
    });
    ws.addEventListener('error', () => reject(new Error('socket error')));
    ws.addEventListener('close', () => reject(new Error('socket closed')));
  });
  return {
    request(type, payload = {}) {
      const id = crypto.randomUUID();
      return new Promise((resolve) => {
        pending.set(id, resolve);
        ws.send(JSON.stringify({ v: 1, id, type, payload }));
      });
    },
    close: () => ws.close(),
  };
}

describe('WebSocket access', () => {
  test('the upgrade needs a valid token', async () => {
    await expect(connect(null)).rejects.toThrow();
    await expect(connect('wrong')).rejects.toThrow();
    const client = await connect(SECRET);
    client.close();
  });

  test('the dashboard may run privileged commands and subscribe to everything', async () => {
    const client = await connect(SECRET);
    try {
      expect((await client.request('subscribe', { events: ['*'] })).ok).toBe(true);
      expect((await client.request('config:get')).ok).toBe(true);
      expect((await client.request('app:config:get', { appSlug: 'other' })).ok).toBe(true);
    } finally {
      client.close();
    }
  });

  test('app tokens are limited to their own app', async () => {
    const client = await connect(POOL_TOKEN);
    const forbidden = async (type: string, payload: unknown): Promise<void> => {
      const res = await client.request(type, payload);
      expect(res.ok).toBe(false);
      expect(res.error?.code).toBe('FORBIDDEN');
    };
    try {
      await forbidden('app:install', { source: 'https://example.com/app.git' });
      await forbidden('app:uninstall', { slug: 'other' });
      await forbidden('config:set', { displayId: 1 });
      await forbidden('subscribe', { events: ['*'] });
      await forbidden('subscribe', { events: ['app:*'] });
      await forbidden('subscribe', { events: ['app:other:topic'] });
      await forbidden('subscribe', { events: ['driver:event:other'] });
      await forbidden('app:config:get', { appSlug: 'other' });
      await forbidden('app:broadcast', { appSlug: 'other', topic: 't' });
      await forbidden('driver:execute', { driver: 'camera', action: 'x' });
      await forbidden('driver:execute', { driver: 'camera', action: 'x', binding: 'other' });
      await forbidden('experience:start', { appSlug: 'other', experienceSlug: 'main' });
      await forbidden('experience:stop', { appSlug: 'other', experienceSlug: 'main' });

      expect((await client.request('subscribe', { events: ['app:pool:topic'] })).ok).toBe(true);
      expect((await client.request('subscribe', { events: ['server:log'] })).ok).toBe(true);
      expect((await client.request('app:config:get', { appSlug: 'pool' })).ok).toBe(true);
      expect((await client.request('app:broadcast', { appSlug: 'pool', topic: 't' })).ok).toBe(
        true,
      );
      expect((await client.request('apps:list')).ok).toBe(true);
    } finally {
      client.close();
    }
  });

  test('commands reject invalid slugs', async () => {
    const client = await connect(SECRET);
    try {
      for (const [type, payload] of [
        ['app:config:get', { appSlug: '../../x' }],
        ['app:config:set', { appSlug: '../../x', settings: {} }],
        ['app:uninstall', { slug: '../x' }],
        ['app:broadcast', { appSlug: 'a:b', topic: 't' }],
        ['driver:get-data', { driver: 'camera', event: 'frame', binding: '../x' }],
        ['experience:start', { appSlug: 'pool', experienceSlug: 'main', driverBinding: '../x' }],
      ] as const) {
        const res = await client.request(type, payload);
        expect(res.ok).toBe(false);
        expect(res.error?.message).toMatch(/must match/);
      }
    } finally {
      client.close();
    }
  });
});
