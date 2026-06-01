/**
 * End-to-end smoke test for Phase 2. Boots the server (which spawns the Python
 * bridge), connects via WebSocket, drives drivers:list, starts/subscribes the
 * heartbeat driver, and verifies it receives at least one `tick` event.
 *
 * Run with: `bun packages/server/test/smoke-e2e.ts`
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from '../src/server.js';

const PORT = 17_777;
const TIMEOUT_MS = 10_000;

const tmp = mkdtempSync(join(tmpdir(), 'gosai-smoke-'));
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

const pythonDir = resolve(import.meta.dir, '..', '..', '..', 'python');

console.log('[smoke] booting server on port', PORT);
const server = await createServer({
  host: '127.0.0.1',
  port: PORT,
  paths,
  pythonDir,
  enablePython: true,
});

try {
  const drivers = (await fetchJson(`/v1/drivers`)) as { drivers: Array<{ name: string }> };
  console.log(
    '[smoke] /v1/drivers names:',
    drivers.drivers.map((d) => d.name),
  );
  if (!drivers.drivers.some((d) => d.name === 'heartbeat')) {
    throw new Error('heartbeat driver missing from manifest - is the bridge running?');
  }

  const events: Array<{ type: string; payload?: unknown }> = [];
  const ws = await openWs();

  ws.addEventListener('message', (ev: MessageEvent) => {
    try {
      const parsed = JSON.parse(String(ev.data)) as { type: string; payload?: unknown };
      events.push(parsed);
    } catch {
      // ignore non-JSON frames
    }
  });

  // Wait for welcome.
  await waitFor(() => events.some((e) => e.type === 'server:welcome'), 3_000);
  console.log('[smoke] received welcome');

  // Subscribe to driver events.
  ws.send(JSON.stringify({ v: 1, type: 'subscribe', payload: { events: ['driver:event'] } }));

  // Subscribe the heartbeat driver.
  await rpc(ws, 'driver:subscribe', { driver: 'heartbeat', event: 'tick' });
  console.log('[smoke] subscribed to heartbeat tick');

  await waitFor(() => events.some((e) => e.type === 'driver:event'), TIMEOUT_MS);
  const firstEvent = events.find((e) => e.type === 'driver:event');
  console.log('[smoke] first driver:event:', JSON.stringify(firstEvent?.payload));

  // Test execute / echo action.
  const echoRequestId = crypto.randomUUID();
  ws.send(
    JSON.stringify({
      v: 1,
      id: echoRequestId,
      type: 'driver:execute',
      payload: { driver: 'heartbeat', action: 'echo', data: { hello: 'world' } },
    }),
  );
  await waitFor(
    () =>
      events.some(
        (e) =>
          e.type === 'response' &&
          typeof e.payload === 'object' &&
          e.payload !== null &&
          (e.payload as { requestId: string }).requestId === echoRequestId,
      ),
    TIMEOUT_MS,
  );
  const echo = events.find(
    (e) =>
      e.type === 'response' &&
      (e.payload as { requestId?: string } | undefined)?.requestId === echoRequestId,
  );
  console.log('[smoke] echo response:', JSON.stringify(echo?.payload));

  await rpc(ws, 'driver:unsubscribe', { driver: 'heartbeat', event: 'tick' });
  ws.close();

  console.log('[smoke] OK');
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
    ws.addEventListener(
      'open',
      () => {
        clearTimeout(t);
        resolveWs(ws);
      },
      { once: true },
    );
    ws.addEventListener('error', (e) => {
      clearTimeout(t);
      reject(new Error(`ws error: ${String((e as ErrorEvent).message)}`));
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
    }, TIMEOUT_MS);
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
