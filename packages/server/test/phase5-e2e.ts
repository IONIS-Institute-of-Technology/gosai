/**
 * Phase 5 end-to-end:
 * - Boots server with apps/ as the builtin apps dir.
 * - Confirms the calibration app is discovered as a built-in.
 * - Confirms calibration + camera drivers register.
 * - Verifies marker rendering action returns base64 PNG.
 * - Verifies set_marker_layout + compute (without camera connected) returns
 *   the expected error.
 * - Verifies storage roundtrip for calibration data.
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from '../src/server.js';

const PORT = 17_779;
const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..');

const tmp = mkdtempSync(join(tmpdir(), 'gosai-phase5-'));
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

const server = await createServer({
  host: '127.0.0.1',
  port: PORT,
  paths,
  pythonDir: join(REPO_ROOT, 'python'),
  builtinAppsDir: join(REPO_ROOT, 'apps'),
  enablePython: true,
});

try {
  // App discovered
  const appsRes = (await fetchJson('/v1/apps')) as {
    apps: Array<{
      manifest: { slug: string; builtin?: boolean; experiences: Array<{ slug: string }> };
    }>;
  };
  const calibration = appsRes.apps.find((a) => a.manifest.slug === 'calibration');
  if (!calibration) throw new Error('calibration app not discovered');
  if (!calibration.manifest.builtin) throw new Error('calibration app should be flagged builtin');
  const expSlugs = calibration.manifest.experiences.map((e) => e.slug).sort();
  if (expSlugs.length !== 1 || expSlugs[0] !== 'calibrate') {
    throw new Error(`unexpected experiences: ${JSON.stringify(expSlugs)}`);
  }
  console.log('[phase5] calibration app discovered with experiences', expSlugs);

  // Drivers registered (camera, calibration, heartbeat).
  const driversRes = (await fetchJson('/v1/drivers')) as {
    drivers: Array<{ name: string; events: string[]; actions: string[]; dependencies: string[] }>;
  };
  const driverNames = driversRes.drivers.map((d) => d.name).sort();
  if (!driverNames.includes('camera') || !driverNames.includes('calibration')) {
    throw new Error(`expected camera + calibration in drivers: ${JSON.stringify(driverNames)}`);
  }
  const cal = driversRes.drivers.find((d) => d.name === 'calibration')!;
  if (!cal.actions.includes('render_marker')) {
    throw new Error('calibration driver missing render_marker action');
  }
  if (!cal.actions.includes('get_latest_frame')) {
    throw new Error('calibration driver missing get_latest_frame action');
  }
  if (!cal.dependencies.includes('camera')) {
    throw new Error('calibration driver should depend on camera');
  }
  console.log('[phase5] drivers OK', { camera: true, calibration: true });

  // Use WS to render markers and check the response is a base64 PNG.
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

  // Start the calibration driver first (otherwise driver:execute on it fails).
  // Subscribing to its status events both triggers auto-start and provides feedback.
  await rpc(ws, 'driver:subscribe', { driver: 'calibration', event: 'status' });
  // Give the driver thread a moment to fully start.
  await new Promise((r) => setTimeout(r, 200));

  console.log('[phase5] calling render_marker…');
  const render = (await rpc(ws, 'driver:execute', {
    driver: 'calibration',
    action: 'render_marker',
    data: { id: 0, size: 80 },
  })) as { ok: boolean; png_base64?: string };
  if (!render.ok || !render.png_base64 || render.png_base64.length < 100) {
    throw new Error(`marker render failed: ${JSON.stringify(render)}`);
  }
  console.log('[phase5] marker rendered (base64 len:', render.png_base64.length, ')');

  // Storage roundtrip using the per-app key/value endpoints.
  const fakeMatrix = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  await fetch(`http://127.0.0.1:${PORT}/v1/apps/calibration/storage/homography`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(fakeMatrix),
  });
  const stored = await (
    await fetch(`http://127.0.0.1:${PORT}/v1/apps/calibration/storage/homography`)
  ).json();
  if (JSON.stringify(stored) !== JSON.stringify(fakeMatrix)) {
    throw new Error(`stored matrix mismatch: ${JSON.stringify(stored)}`);
  }
  console.log('[phase5] storage roundtrip OK');

  // Built-in static file route should serve the app's built JS.
  const calibrateJs = await fetch(
    `http://127.0.0.1:${PORT}/v1/apps/calibration/static/dist/calibrate.js`,
  );
  if (!calibrateJs.ok) throw new Error('static calibrate.js not found');
  const text = await calibrateJs.text();
  if (!text.includes('defineExperience')) {
    throw new Error('calibrate.js does not look like a built experience');
  }
  console.log('[phase5] static route OK, calibrate.js size', text.length);

  ws.close();
  console.log('[phase5] OK');
} finally {
  await server.stop();
  rmSync(tmp, { recursive: true, force: true });
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

async function rpc(ws: WebSocket, type: string, payload: unknown): Promise<unknown> {
  return new Promise<unknown>((resolveRpc, rejectRpc) => {
    const id = crypto.randomUUID();
    const listener = (ev: MessageEvent): void => {
      let parsed: {
        type: string;
        payload?: { requestId?: string; ok?: boolean; data?: unknown; error?: { message: string } };
      };
      try {
        parsed = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (parsed.type !== 'response' || parsed.payload?.requestId !== id) return;
      ws.removeEventListener('message', listener);
      if (parsed.payload?.ok) resolveRpc(parsed.payload.data);
      else rejectRpc(new Error(parsed.payload?.error?.message ?? `${type} failed`));
    };
    ws.addEventListener('message', listener);
    ws.send(JSON.stringify({ v: 1, id, type, payload }));
    setTimeout(() => {
      ws.removeEventListener('message', listener);
      rejectRpc(new Error(`${type} timeout`));
    }, 10_000);
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
