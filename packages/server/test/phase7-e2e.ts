/**
 * Phase 7 end-to-end integration:
 *
 * 1. Boots a clean server.
 * 2. Installs the in-repo `templates/basic` "app" using a local-path source
 *    (so the test doesn't need network access).
 * 3. Confirms the app is catalogued, the package was bun-installed, and the
 *    build output exists at the expected static path.
 * 4. Starts the template app's experience over WebSocket and confirms it is
 *    listed as a running experience.
 * 5. Stops the experience and verifies graceful teardown.
 * 6. Uninstalls the app and verifies the entry is removed.
 *
 * The installer normally clones from git. To keep this test hermetic and
 * offline, we pass a `file:` URL pointing at a git mirror we create from the
 * template directory.
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from '../src/server.js';

const PORT = 17_795;
const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..');
const TEMPLATE_DIR = join(REPO_ROOT, 'templates', 'basic');

const tmp = mkdtempSync(join(tmpdir(), 'gosai-phase7-'));
const paths = {
  root: tmp,
  apps: ensure(join(tmp, 'apps')),
  logs: ensure(join(tmp, 'logs')),
  data: ensure(join(tmp, 'data')),
  config: ensure(join(tmp, 'config')),
};
const sourceRepoDir = join(tmp, 'source-repo');

function ensure(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function git(args: string[], cwd: string): Promise<void> {
  const child = Bun.spawn({
    cmd: ['git', ...args],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 'gosai-test',
      GIT_AUTHOR_EMAIL: 'test@gosai.local',
      GIT_COMMITTER_NAME: 'gosai-test',
      GIT_COMMITTER_EMAIL: 'test@gosai.local',
    },
  });
  const code = await child.exited;
  if (code !== 0) {
    const stderr = await new Response(child.stderr).text();
    throw new Error(`git ${args.join(' ')} failed: ${stderr}`);
  }
}

async function setupSourceRepo(): Promise<string> {
  mkdirSync(sourceRepoDir, { recursive: true });
  await Bun.spawn({
    cmd: ['cp', '-R', `${TEMPLATE_DIR}/.`, sourceRepoDir],
  }).exited;
  await git(['init', '-q', '-b', 'main'], sourceRepoDir);
  await git(['add', '.'], sourceRepoDir);
  await git(['commit', '-q', '-m', 'initial'], sourceRepoDir);
  return sourceRepoDir;
}

const sourceRepo = await setupSourceRepo();

const server = await createServer({
  host: '127.0.0.1',
  port: PORT,
  paths,
  pythonDir: join(REPO_ROOT, 'python'),
  builtinAppsDir: join(REPO_ROOT, 'apps'),
  enablePython: true,
});

const baseUrl = `http://127.0.0.1:${PORT}`;

try {
  // 1. Install from the file-based git repo we just created.
  console.log('[phase7] installing app from', sourceRepo);
  const installRes = await fetch(`${baseUrl}/v1/info`);
  if (!installRes.ok) throw new Error('server not up');

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

  await rpc(ws, 'app:install', { source: `file://${sourceRepo}` });

  const apps = (await (await fetch(`${baseUrl}/v1/apps`)).json()) as {
    apps: Array<{ manifest: { slug: string; experiences: Array<{ slug: string }> }; installPath: string }>;
  };
  const installed = apps.apps.find((a) => a.manifest.slug === 'hello-gosai');
  if (!installed) {
    throw new Error(`hello-gosai not installed; got ${JSON.stringify(apps.apps.map((a) => a.manifest.slug))}`);
  }
  console.log('[phase7] installed:', installed.manifest.slug, '@', installed.installPath);

  // 2. Build output (dist/main.js) should exist + be served via static route.
  const staticRes = await fetch(`${baseUrl}/v1/apps/hello-gosai/static/dist/main.js`);
  if (!staticRes.ok) throw new Error(`static main.js not served: ${staticRes.status}`);
  const mainText = await staticRes.text();
  if (!mainText.includes('defineExperience')) {
    throw new Error('built main.js does not look like an experience');
  }
  console.log('[phase7] static dist/main.js served, size =', mainText.length);

  // 3. Start the main experience.
  const startRes = (await rpc(ws, 'experience:start', {
    appSlug: 'hello-gosai',
    experienceSlug: 'main',
  })) as { appSlug: string; experienceSlug: string; state: string };
  if (startRes.state !== 'running') {
    throw new Error(`experience did not reach running state: ${JSON.stringify(startRes)}`);
  }
  console.log('[phase7] experience running');

  const running = (await (await fetch(`${baseUrl}/v1/experiences`)).json()) as {
    experiences: Array<{ appSlug: string; experienceSlug: string; state: string }>;
  };
  if (!running.experiences.some((e) => e.appSlug === 'hello-gosai')) {
    throw new Error('experience not in running list');
  }

  // 4. Stop the experience.
  await rpc(ws, 'experience:stop', { appSlug: 'hello-gosai', experienceSlug: 'main' });
  const after = (await (await fetch(`${baseUrl}/v1/experiences`)).json()) as {
    experiences: Array<{ appSlug: string }>;
  };
  if (after.experiences.some((e) => e.appSlug === 'hello-gosai')) {
    throw new Error('experience still running after stop');
  }
  console.log('[phase7] experience stopped cleanly');

  // 5. Uninstall.
  await rpc(ws, 'app:uninstall', { slug: 'hello-gosai' });
  const afterUninstall = (await (await fetch(`${baseUrl}/v1/apps`)).json()) as {
    apps: Array<{ manifest: { slug: string } }>;
  };
  if (afterUninstall.apps.some((a) => a.manifest.slug === 'hello-gosai')) {
    throw new Error('hello-gosai still installed after uninstall');
  }
  console.log('[phase7] uninstall OK');

  ws.close();
  console.log('[phase7] OK');
} finally {
  await server.stop();
  rmSync(tmp, { recursive: true, force: true });
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
        payload?: {
          requestId?: string;
          ok?: boolean;
          data?: unknown;
          error?: { message: string };
        };
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
    }, 30_000);
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
