/**
 * Phase 4 end-to-end test:
 * - Boots the server
 * - Symlinks the basic template into the apps directory
 * - Verifies discovery via /v1/apps
 * - Verifies the static file route serves the template's built module
 * - Verifies the storage REST endpoints work
 * - Verifies SDK runtime is served at /sdk-runtime.js
 * - Starts the experience via WS, confirms subscription, stops it
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from '../src/server.js';

const PORT = 17_778;
const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..');

const tmp = mkdtempSync(join(tmpdir(), 'gosai-phase4-'));
const paths = {
  root: tmp,
  apps: ensure(join(tmp, 'apps')),
  logs: ensure(join(tmp, 'logs')),
  data: ensure(join(tmp, 'data')),
  config: ensure(join(tmp, 'config')),
};

function ensure(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

// Symlink the template into the apps directory.
const templatePath = join(REPO_ROOT, 'templates', 'basic');
const distPath = join(templatePath, 'dist', 'main.js');
if (!existsSync(distPath)) {
  console.error('[phase4] template not built. Run: bun run --filter hello-gosai build');
  process.exit(2);
}
const appLink = join(paths.apps, 'hello-gosai');
symlinkSync(templatePath, appLink, 'dir');

console.log('[phase4] booting server');
const server = await createServer({
  host: '127.0.0.1',
  port: PORT,
  paths,
  enablePython: true,
  pythonDir: join(REPO_ROOT, 'python'),
});

try {
  // 1. App appears in catalogue.
  const apps = (await fetchJson('/v1/apps')) as {
    apps: Array<{ manifest: { slug: string; experiences: { slug: string; entry: string }[] } }>;
  };
  const hello = apps.apps.find((a) => a.manifest.slug === 'hello-gosai');
  if (!hello) throw new Error('hello-gosai not discovered');
  console.log('[phase4] discovered hello-gosai with experiences:', hello.manifest.experiences.map((e) => e.slug));

  // 2. SDK runtime is served.
  const sdkRes = await fetch(`http://127.0.0.1:${PORT}/sdk-runtime.js`);
  if (!sdkRes.ok) throw new Error(`sdk-runtime returned ${sdkRes.status}`);
  const sdkText = await sdkRes.text();
  if (!sdkText.includes('runExperience')) {
    throw new Error('SDK runtime missing expected exports');
  }
  console.log('[phase4] sdk-runtime.js ok, size', sdkText.length);

  // 3. Static file route works.
  const entry = hello.manifest.experiences[0]!.entry;
  const entryRes = await fetch(`http://127.0.0.1:${PORT}/v1/apps/hello-gosai/static/${entry}`);
  if (!entryRes.ok) throw new Error(`entry returned ${entryRes.status}`);
  const entryText = await entryRes.text();
  if (!entryText.includes('defineExperience')) {
    throw new Error('built experience module does not reference defineExperience');
  }
  console.log('[phase4] /v1/apps/hello-gosai/static/dist/main.js ok, size', entryText.length);

  // 4. Storage roundtrip.
  const setRes = await fetch(
    `http://127.0.0.1:${PORT}/v1/apps/hello-gosai/storage/last-tick`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(42),
    },
  );
  if (!setRes.ok) throw new Error(`storage.set returned ${setRes.status}`);
  const getRes = await fetch(`http://127.0.0.1:${PORT}/v1/apps/hello-gosai/storage/last-tick`);
  const getValue = await getRes.json();
  if (getValue !== 42) throw new Error(`storage roundtrip failed: ${JSON.stringify(getValue)}`);
  console.log('[phase4] storage roundtrip ok');

  const listRes = await fetch(`http://127.0.0.1:${PORT}/v1/apps/hello-gosai/storage`);
  const listJson = (await listRes.json()) as { keys: string[] };
  if (!listJson.keys.includes('last-tick')) {
    throw new Error(`storage list missing 'last-tick': ${JSON.stringify(listJson)}`);
  }

  const delRes = await fetch(`http://127.0.0.1:${PORT}/v1/apps/hello-gosai/storage/last-tick`, {
    method: 'DELETE',
  });
  if (!delRes.ok) throw new Error(`storage.delete returned ${delRes.status}`);
  console.log('[phase4] storage delete ok');

  // 5. Start experience via WS.
  const ws = await openWs();
  const events: Array<{ type: string; payload?: unknown }> = [];
  ws.addEventListener('message', (ev) => {
    try {
      events.push(JSON.parse(String(ev.data)) as { type: string; payload?: unknown });
    } catch {
      // ignore
    }
  });
  await waitFor(() => events.some((e) => e.type === 'server:welcome'), 3_000);

  ws.send(
    JSON.stringify({
      v: 1,
      type: 'subscribe',
      payload: { events: ['experience:state-changed', 'driver:event'] },
    }),
  );

  const startReqId = crypto.randomUUID();
  ws.send(
    JSON.stringify({
      v: 1,
      id: startReqId,
      type: 'experience:start',
      payload: { appSlug: 'hello-gosai', experienceSlug: 'main' },
    }),
  );

  await waitFor(
    () =>
      events.some(
        (e) =>
          e.type === 'response' &&
          (e.payload as { requestId?: string } | undefined)?.requestId === startReqId,
      ),
    10_000,
  );
  const startResp = events.find(
    (e) =>
      e.type === 'response' &&
      (e.payload as { requestId?: string } | undefined)?.requestId === startReqId,
  );
  const startOk = (startResp?.payload as { ok?: boolean } | undefined)?.ok;
  if (!startOk) {
    throw new Error(`experience start failed: ${JSON.stringify(startResp?.payload)}`);
  }
  console.log('[phase4] experience started');

  // Verify state change broadcast.
  await waitFor(
    () =>
      events.some(
        (e) =>
          e.type === 'experience:state-changed' &&
          (e.payload as { state: string } | undefined)?.state === 'running',
      ),
    5_000,
  );
  console.log('[phase4] experience:state-changed running broadcast received');

  // Verify driver event flows (heartbeat ticking).
  await waitFor(() => events.some((e) => e.type === 'driver:event'), 5_000);
  console.log('[phase4] driver:event received');

  // Stop experience.
  await fetch(`http://127.0.0.1:${PORT}/v1/experiences`);
  const stopReqId = crypto.randomUUID();
  ws.send(
    JSON.stringify({
      v: 1,
      id: stopReqId,
      type: 'experience:stop',
      payload: { appSlug: 'hello-gosai', experienceSlug: 'main' },
    }),
  );
  await waitFor(
    () =>
      events.some(
        (e) =>
          e.type === 'response' &&
          (e.payload as { requestId?: string } | undefined)?.requestId === stopReqId,
      ),
    5_000,
  );
  console.log('[phase4] experience stopped');

  ws.close();
  console.log('[phase4] OK');
} finally {
  await server.stop();
  rmSync(tmp, { recursive: true, force: true });
  void readFileSync;
}

async function fetchJson(path: string): Promise<unknown> {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

async function openWs(): Promise<WebSocket> {
  return new Promise<WebSocket>((resolveWs, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const t = setTimeout(() => reject(new Error('ws open timeout')), 3_000);
    ws.addEventListener('open', () => {
      clearTimeout(t);
      resolveWs(ws);
    });
    ws.addEventListener('error', () => {
      clearTimeout(t);
      reject(new Error('ws error'));
    });
  });
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('waitFor timed out');
}
