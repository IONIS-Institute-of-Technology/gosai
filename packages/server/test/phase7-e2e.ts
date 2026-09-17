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
import { ServerClient } from '@gosai/shared/client';
import { createServer } from '../src/server.js';

// Installs a real app with git and bun, so it only runs when asked:
// `GOSAI_E2E_INSTALL=1 bun packages/server/test/phase7-e2e.ts`.
if (process.env.GOSAI_E2E_INSTALL !== '1') {
  console.log('[phase7] skipped; set GOSAI_E2E_INSTALL=1 to run the install test');
  process.exit(0);
}

const PORT = 17_795;
const TOKEN = 'e2e-dashboard-token';
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
  dashboardToken: TOKEN,
  allowFileInstalls: true,
});

const baseUrl = `http://127.0.0.1:${PORT}`;
const client = new ServerClient({ url: `ws://127.0.0.1:${PORT}/ws`, token: TOKEN });

try {
  client.connect();
  await client.ready(3_000);

  // 1. Install from the file-based git repo we just created.
  console.log('[phase7] installing app from', sourceRepo);
  await client.request('app:install', { source: `file://${sourceRepo}` });

  const { apps } = await client.request('apps:list');
  const installed = apps.find((a) => a.manifest.slug === 'hello-gosai');
  if (!installed) {
    throw new Error(
      `hello-gosai not installed; got ${JSON.stringify(apps.map((a) => a.manifest.slug))}`,
    );
  }
  console.log('[phase7] installed:', installed.manifest.slug);

  // 2. Build output (dist/main.js) should exist + be served via static route.
  const staticRes = await fetch(`${baseUrl}/v1/apps/hello-gosai/static/dist/main.js`);
  if (!staticRes.ok) throw new Error(`static main.js not served: ${staticRes.status}`);
  const mainText = await staticRes.text();
  if (!mainText.includes('defineExperience')) {
    throw new Error('built main.js does not look like an experience');
  }
  console.log('[phase7] static dist/main.js served, size =', mainText.length);

  // 3. Start the main experience.
  const started = await client.request('experience:start', {
    appSlug: 'hello-gosai',
    experienceSlug: 'main',
  });
  if (started.state !== 'running') {
    throw new Error(`experience did not reach running state: ${JSON.stringify(started)}`);
  }
  const running = await client.request('experiences:list');
  if (!running.experiences.some((e) => e.appSlug === 'hello-gosai')) {
    throw new Error('experience not in running list');
  }
  console.log('[phase7] experience running');

  // 4. Stop the experience.
  await client.request('experience:stop', { appSlug: 'hello-gosai', experienceSlug: 'main' });
  const after = await client.request('experiences:list');
  if (after.experiences.some((e) => e.appSlug === 'hello-gosai')) {
    throw new Error('experience still running after stop');
  }
  console.log('[phase7] experience stopped cleanly');

  // 5. Uninstall.
  await client.request('app:uninstall', { slug: 'hello-gosai' });
  const afterUninstall = await client.request('apps:list');
  if (afterUninstall.apps.some((a) => a.manifest.slug === 'hello-gosai')) {
    throw new Error('hello-gosai still installed after uninstall');
  }
  console.log('[phase7] uninstall OK');
  console.log('[phase7] OK');
} finally {
  client.close();
  await server.stop();
  rmSync(tmp, { recursive: true, force: true });
}
