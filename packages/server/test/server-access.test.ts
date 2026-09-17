import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mintAppToken } from '@gosai/shared/auth';
import { createServer, type GosaiServer } from '../src/server.js';

const SECRET = 'test-dashboard-token';
const POOL_TOKEN = mintAppToken(SECRET, 'pool');

let server: GosaiServer;
let base: string;
let dataDir: string;
let sdkDir: string;

function writeApp(dir: string, slug: string, extra: Record<string, unknown> = {}): void {
  mkdirSync(join(dir, 'dist'), { recursive: true });
  writeFileSync(
    join(dir, 'gosai.app.json'),
    JSON.stringify({
      slug,
      name: slug,
      version: '0.0.0',
      experiences: [{ slug: 'main', name: 'Main', entry: 'dist/main.js' }],
      ...extra,
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
  dataDir = paths.data;
  const builtin = join(tmp, 'builtin');
  writeApp(join(builtin, 'pool'), 'pool');
  writeApp(join(builtin, 'relay'), 'relay', {
    network: { connect: ['ws://relay.local:8080', 'http://192.168.1.20'] },
  });
  writeApp(join(paths.apps, 'other'), 'other');
  writeFileSync(join(tmp, 'outside.txt'), 'outside');
  symlinkSync(join(tmp, 'outside.txt'), join(builtin, 'pool', 'dist', 'leak.txt'));

  sdkDir = join(tmp, 'sdk');
  mkdirSync(sdkDir);
  writeFileSync(join(sdkDir, 'index.js'), 'export const sdk = 1;');
  writeFileSync(join(sdkDir, 'host.js'), 'export const host = 1;');
  writeFileSync(join(sdkDir, 'secret.txt'), 'not javascript');

  server = await createServer({
    sdkDir,
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
    expect((await fetch(`${base}/v1/info`, { headers: bearer(POOL_TOKEN) })).status).toBe(200);
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
    const preflight = await fetch(`${base}/v1/info`, {
      method: 'OPTIONS',
      headers: { origin: 'http://localhost:5173' },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect(preflight.headers.get('access-control-allow-headers')).toContain('Authorization');
    const plain = await fetch(`${base}/healthz`);
    expect(plain.headers.get('access-control-allow-origin')).toBeNull();
  });

  test("static route doesn't serve app storage, settings or dot files", async () => {
    // Data moved out of app directories; a leftover old copy still stays private.
    const legacy = join(server.apps.getInstallPath('other')!, '_data', 'storage');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'secret.json'), JSON.stringify('hidden'));
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

  test('routes that duplicated WebSocket commands are gone', async () => {
    for (const path of ['/v1/apps', '/v1/drivers', '/v1/experiences', '/v1/config', '/v1/logs']) {
      expect((await fetch(`${base}${path}`, { headers: bearer(SECRET) })).status).toBe(404);
    }
    const start = await fetch(`${base}/v1/experiences/start`, {
      method: 'POST',
      headers: { ...bearer(SECRET), 'content-type': 'application/json' },
      body: JSON.stringify({ appSlug: 'pool', experienceSlug: 'main' }),
    });
    expect(start.status).toBe(404);
    expect(
      (await fetch(`${base}/v1/apps/pool/storage/key`, { headers: bearer(SECRET) })).status,
    ).toBe(404);
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
  nextEvent(type: string): Promise<unknown>;
  onEvent(type: string, listener: (payload: unknown) => void): void;
  close(): void;
}> {
  const url =
    token === null
      ? `${base.replace('http', 'ws')}/ws`
      : `${base.replace('http', 'ws')}/ws?token=${encodeURIComponent(token)}`;
  const ws = new WebSocket(url);
  const pending = new Map<string, (res: CommandResponse) => void>();
  const waiting = new Map<string, (payload: unknown) => void>();
  const listeners = new Map<string, (payload: unknown) => void>();
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data)) as {
        type: string;
        payload: CommandResponse & { requestId: string };
      };
      if (msg.type === 'server:welcome') resolve();
      if (msg.type === 'response') pending.get(msg.payload.requestId)?.(msg.payload);
      else {
        waiting.get(msg.type)?.(msg.payload);
        listeners.get(msg.type)?.(msg.payload);
      }
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
    nextEvent(type) {
      return new Promise((resolve) => waiting.set(type, resolve));
    },
    onEvent(type, listener) {
      listeners.set(type, listener);
    },
    close: () => ws.close(),
  };
}

describe('storage commands', () => {
  test('app tokens only reach their own storage', async () => {
    const pool = await connect(POOL_TOKEN);
    const dashboard = await connect(SECRET);
    try {
      expect(
        (await pool.request('storage:set', { appSlug: 'pool', key: 'score', value: 3 })).ok,
      ).toBe(true);
      expect((await pool.request('storage:get', { appSlug: 'pool', key: 'score' })).data).toEqual({
        found: true,
        value: 3,
      });
      expect((await pool.request('storage:get', { appSlug: 'pool', key: 'missing' })).data).toEqual(
        {
          found: false,
        },
      );
      expect((await pool.request('storage:list', { appSlug: 'pool' })).data).toEqual({
        keys: ['score'],
      });

      for (const [type, payload] of [
        ['storage:get', { appSlug: 'other', key: 'score' }],
        ['storage:list', { appSlug: 'other' }],
        ['storage:set', { appSlug: 'other', key: 'score', value: 1 }],
        ['storage:remove', { appSlug: 'other', key: 'score' }],
      ] as const) {
        const res = await pool.request(type, payload);
        expect(res.error?.code).toBe('FORBIDDEN');
      }

      expect(
        (await dashboard.request('storage:get', { appSlug: 'pool', key: 'score' })).data,
      ).toEqual({
        found: true,
        value: 3,
      });
      expect(
        (await pool.request('storage:remove', { appSlug: 'pool', key: 'score' })).data,
      ).toEqual({
        removed: true,
      });
      const unknownApp = await dashboard.request('storage:get', { appSlug: 'ghost', key: 'k' });
      expect(unknownApp.error?.code).toBe('HANDLER_ERROR');
    } finally {
      pool.close();
      dashboard.close();
    }
  });

  test('stored values live in the data directory', async () => {
    const dashboard = await connect(SECRET);
    try {
      await dashboard.request('storage:set', { appSlug: 'other', key: 'where', value: 'data' });
      expect(server.storage.get('other', 'where')).toEqual({ found: true, value: 'data' });
      expect(existsSync(join(dataDir, 'other', 'storage', 'where.json'))).toBe(true);
    } finally {
      dashboard.close();
    }
  });
});

describe('app broadcasts', () => {
  test('reach the other windows of the app but not the sender', async () => {
    const sender = await connect(POOL_TOKEN);
    const receiver = await connect(POOL_TOKEN);
    try {
      for (const client of [sender, receiver]) {
        expect((await client.request('subscribe', { events: ['app:pool:ping'] })).ok).toBe(true);
      }
      const echoed: unknown[] = [];
      sender.onEvent('app:pool:ping', (payload) => echoed.push(payload));
      const received = receiver.nextEvent('app:pool:ping');
      expect(
        (await sender.request('app:broadcast', { appSlug: 'pool', topic: 'ping', data: 7 })).ok,
      ).toBe(true);
      expect(await received).toBe(7);
      // A round trip on the sender's socket shows nothing was queued behind the reply.
      expect((await sender.request('system:ping')).ok).toBe(true);
      expect(echoed).toEqual([]);
    } finally {
      sender.close();
      receiver.close();
    }
  });
});

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
      expect((await client.request('drivers:schema', {})).data).toEqual({ schemas: {} });
      const unknown = await client.request('drivers:schema', { driver: 'nope' });
      expect(unknown.error?.message).toBe('Unknown driver: nope');
      expect((await client.request('drivers:schema', { driver: 7 })).error?.code).toBe(
        'INVALID_PAYLOAD',
      );
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
      await forbidden('logs:history', {});
      await forbidden('subscribe', { events: ['server:log'] });
      await forbidden('app:uninstall', { slug: 'other' });
      await forbidden('config:set', { displayId: 1 });
      await forbidden('subscribe', { events: ['*'] });
      await forbidden('subscribe', { events: ['app:*'] });
      await forbidden('subscribe', { events: ['app:other:topic'] });
      await forbidden('subscribe', { events: ['driver:event:other'] });

      // A batch with one denied event still subscribes the allowed ones.
      const batch = await client.request('subscribe', {
        events: ['app:pool:batched', 'app:other:batched'],
      });
      expect(batch.ok).toBe(false);
      expect(batch.error?.message).toContain('app:other:batched');
      expect(batch.error?.message).not.toContain('app:pool:batched');
      const received = client.nextEvent('app:pool:batched');
      // Broadcasts skip the sender, so another window of the app sends it.
      const otherWindow = await connect(POOL_TOKEN);
      expect(
        (
          await otherWindow.request('app:broadcast', {
            appSlug: 'pool',
            topic: 'batched',
            data: { n: 1 },
          })
        ).ok,
      ).toBe(true);
      expect(await received).toEqual({ n: 1 });
      otherWindow.close();
      await forbidden('app:config:get', { appSlug: 'other' });
      await forbidden('app:broadcast', { appSlug: 'other', topic: 't' });
      await forbidden('driver:execute', { driver: 'camera', action: 'x' });
      await forbidden('driver:execute', { driver: 'camera', action: 'x', binding: 'other' });
      await forbidden('experience:start', { appSlug: 'other', experienceSlug: 'main' });
      await forbidden('experience:stop', { appSlug: 'other', experienceSlug: 'main' });

      expect((await client.request('subscribe', { events: ['app:pool:topic'] })).ok).toBe(true);
      expect((await client.request('subscribe', { events: ['system:stats'] })).ok).toBe(true);
      expect((await client.request('app:config:get', { appSlug: 'pool' })).ok).toBe(true);
      expect((await client.request('app:broadcast', { appSlug: 'pool', topic: 't' })).ok).toBe(
        true,
      );
      const listed = await client.request('apps:list');
      expect(listed.ok).toBe(true);
      expect(JSON.stringify(listed.data)).not.toContain('installPath');
      await forbidden('app:log', { source: 'server', message: 'spoofed' });
      expect((await client.request('app:log', { source: 'app:pool:main', message: 'hi' })).ok).toBe(
        true,
      );
      expect((await client.request('drivers:schema', {})).ok).toBe(true);
      expect((await client.request('system:ping')).ok).toBe(true);
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
        ['storage:get', { appSlug: '../x', key: 'k' }],
      ] as const) {
        const res = await client.request(type, payload);
        expect(res.ok).toBe(false);
        expect(res.error?.code).toBe('INVALID_PAYLOAD');
        expect(res.error?.message).toMatch(/must match/);
      }
    } finally {
      client.close();
    }
  });
});

describe('app origins', () => {
  const appHost = (slug: string): string => `${slug}.localhost:${server.port}`;
  const directives = (csp: string | null): Map<string, string[]> =>
    new Map(
      (csp ?? '')
        .split(';')
        .map((part) => part.trim().split(/\s+/))
        .filter((words) => words[0])
        .map(([name, ...values]) => [name!, values]),
    );

  test('serves the host page with a CSP that allows the import map by hash', async () => {
    const res = await fetch(`${base}/?experience=main`, { headers: { host: appHost('pool') } });
    expect(res.status).toBe(200);
    const html = await res.text();
    const csp = res.headers.get('content-security-policy')!;
    expect(csp).not.toContain('unsafe-inline');
    const importMap = /<script type="importmap">(.*?)<\/script>/.exec(html)![1]!;
    const hash = new Bun.CryptoHasher('sha256').update(importMap).digest('base64');
    expect(directives(csp).get('script-src')).toContain(`'sha256-${hash}'`);
    expect(JSON.parse(importMap).imports).toEqual({
      '@gosai/sdk': '/sdk/index.js',
      '@gosai/sdk/': '/sdk/',
    });
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });

  test('connect-src allows blob and data URLs and TLS, but not plain http or ws', async () => {
    const res = await fetch(`${base}/`, { headers: { host: appHost('pool') } });
    const connect = directives(res.headers.get('content-security-policy')).get('connect-src');
    expect(connect).toEqual(["'self'", 'blob:', 'data:', 'https:', 'wss:']);
  });

  test("the manifest's network.connect entries extend only that app's connect-src", async () => {
    const relay = await fetch(`${base}/`, { headers: { host: appHost('relay') } });
    expect(directives(relay.headers.get('content-security-policy')).get('connect-src')).toEqual([
      "'self'",
      'blob:',
      'data:',
      'https:',
      'wss:',
      'ws://relay.local:8080',
      'http://192.168.1.20',
    ]);
    const pool = await fetch(`${base}/`, { headers: { host: appHost('pool') } });
    expect(pool.headers.get('content-security-policy')).not.toContain('relay.local');
  });

  test('every response on an app host carries the policy, and only there', async () => {
    const policy = (await fetch(`${base}/`, { headers: { host: appHost('pool') } })).headers.get(
      'content-security-policy',
    );
    for (const path of ['/v1/apps/pool/static/dist/main.js', '/sdk/index.js', '/gosai.app.json']) {
      const res = await fetch(`${base}${path}`, { headers: { host: appHost('pool') } });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-security-policy')).toBe(policy);
    }
    const loopback = await fetch(`${base}/v1/apps/pool/static/dist/main.js`);
    expect(loopback.headers.get('content-security-policy')).toBeNull();
  });

  test("an app host serves only its own app's static files", async () => {
    const own = await fetch(`${base}/v1/apps/relay/static/dist/main.js`, {
      headers: { host: appHost('relay') },
    });
    expect(own.status).toBe(200);
    const other = await fetch(`${base}/v1/apps/pool/static/dist/main.js`, {
      headers: { host: appHost('relay') },
    });
    expect(other.status).toBe(404);
    // Another app's page may still import it from that app's origin.
    const crossOrigin = await fetch(`${base}/v1/apps/pool/static/dist/main.js`, {
      headers: { host: appHost('pool'), origin: `http://${appHost('relay')}` },
    });
    expect(crossOrigin.status).toBe(200);
    expect(crossOrigin.headers.get('access-control-allow-origin')).toBe(
      `http://${appHost('relay')}`,
    );
  });

  test('only app hostnames get a host page and a manifest', async () => {
    expect((await fetch(`${base}/`)).status).toBe(404);
    expect((await fetch(`${base}/gosai.app.json`)).status).toBe(404);
    const manifest = await fetch(`${base}/gosai.app.json`, { headers: { host: appHost('pool') } });
    expect(manifest.status).toBe(200);
    expect(((await manifest.json()) as { slug: string }).slug).toBe('pool');
    const missing = await fetch(`${base}/gosai.app.json`, { headers: { host: appHost('ghost') } });
    expect(missing.status).toBe(404);
  });

  test('rejects hostnames that are not app slugs', async () => {
    for (const host of [`bad_slug.localhost:${server.port}`, `a.b.localhost:${server.port}`]) {
      expect((await fetch(`${base}/`, { headers: { host } })).status).toBe(403);
    }
  });

  test('serves SDK bundle files, with or without the .js extension', async () => {
    const index = await fetch(`${base}/sdk/index.js`);
    expect(index.status).toBe(200);
    expect(index.headers.get('content-type')).toContain('javascript');
    expect(await (await fetch(`${base}/sdk/host`)).text()).toContain('host');
    for (const path of ['secret.txt', '..%2Fserver.ts', 'missing.js']) {
      expect((await fetch(`${base}/sdk/${path}`)).status).toBe(404);
    }
    const legacy = await fetch(`${base}/sdk-runtime.js`, { redirect: 'manual' });
    expect(legacy.status).toBe(308);
    expect(legacy.headers.get('location')).toBe('/sdk/index.js');
  });

  test("app origins may call the server with their own app's token only", async () => {
    const own = await fetch(`${base}/v1/info`, {
      headers: { ...bearer(POOL_TOKEN), host: appHost('pool') },
    });
    expect(own.status).toBe(200);
    const crossOrigin = await fetch(`${base}/v1/info`, {
      headers: { ...bearer(POOL_TOKEN), origin: `http://${appHost('pool')}` },
    });
    expect(crossOrigin.status).toBe(200);
    expect(crossOrigin.headers.get('access-control-allow-origin')).toBe(
      `http://${appHost('pool')}`,
    );

    const otherOrigin = await fetch(`${base}/v1/info`, {
      headers: { ...bearer(POOL_TOKEN), host: appHost('other') },
    });
    expect(otherOrigin.status).toBe(403);
    const dashboardFromApp = await fetch(`${base}/v1/info`, {
      headers: { ...bearer(SECRET), origin: `http://${appHost('pool')}` },
    });
    expect(dashboardFromApp.status).toBe(403);
  });

  test('the WebSocket upgrade checks the token against the app origin', async () => {
    const open = (token: string, origin: string): Promise<boolean> =>
      new Promise((resolve) => {
        const url = `${base.replace('http', 'ws')}/ws?token=${encodeURIComponent(token)}`;
        const ws = new WebSocket(url, { headers: { origin } } as unknown as string[]);
        ws.addEventListener('open', () => {
          ws.close();
          resolve(true);
        });
        ws.addEventListener('error', () => resolve(false));
      });
    expect(await open(POOL_TOKEN, `http://${appHost('pool')}`)).toBe(true);
    expect(await open(POOL_TOKEN, `http://${appHost('other')}`)).toBe(false);
    expect(await open(SECRET, `http://${appHost('pool')}`)).toBe(false);
  });
});
