import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, test } from 'bun:test';

const entry = resolve(import.meta.dir, '..', 'src', 'index.ts');
const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function startServer(extraEnv: Record<string, string>) {
  const home = mkdtempSync(join(tmpdir(), 'gosai-stdin-'));
  homes.push(home);
  return Bun.spawn({
    cmd: [process.execPath, entry],
    env: {
      ...process.env,
      GOSAI_HOME: home,
      GOSAI_PORT: '0',
      GOSAI_PYTHON: '0',
      GOSAI_BUILTIN_APPS: join(home, 'no-apps'),
      GOSAI_DASHBOARD_TOKEN: 'stdin-test-token',
      ...extraEnv,
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'inherit',
  });
}

async function waitForReady(stdout: ReadableStream<Uint8Array>): Promise<void> {
  const decoder = new TextDecoder();
  let text = '';
  for await (const chunk of stdout) {
    text += decoder.decode(chunk);
    if (text.includes('GOSAI_READY ')) return;
  }
  throw new Error(`server exited before GOSAI_READY:\n${text}`);
}

test('exits cleanly when its stdin closes and GOSAI_EXIT_ON_STDIN_CLOSE=1', async () => {
  const child = startServer({ GOSAI_EXIT_ON_STDIN_CLOSE: '1' });
  await waitForReady(child.stdout);
  await child.stdin.end();
  const code = await Promise.race([child.exited, Bun.sleep(10_000).then(() => 'timeout' as const)]);
  if (code === 'timeout') child.kill('SIGKILL');
  expect(code).toBe(0);
}, 20_000);

test('keeps running after stdin closes without the variable', async () => {
  const child = startServer({});
  await waitForReady(child.stdout);
  await child.stdin.end();
  const early = await Promise.race([child.exited, Bun.sleep(1_000).then(() => 'running')]);
  child.kill('SIGTERM');
  await child.exited;
  expect(early).toBe('running');
}, 20_000);
