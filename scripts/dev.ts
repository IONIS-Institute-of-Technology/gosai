/**
 * `bun run dev`: starts the server, the SDK watcher and the desktop app with
 * one dashboard token, so the separately started server accepts the desktop
 * windows. Set GOSAI_DASHBOARD_TOKEN to choose the token yourself.
 *
 * Each package runs its own `bun run dev` in its own directory rather than one
 * `bun run --filter` over the three: a filtered run holds a package back until
 * the scripts of the packages it depends on exit, and the SDK watcher never
 * exits, so the server would never start. The output is prefixed here instead
 * of by bun, whose live filter view expects to own the terminal.
 */

import { generateDashboardToken } from '@gosai/shared/auth';

const token = process.env.GOSAI_DASHBOARD_TOKEN || generateDashboardToken();

const processes = ['server', 'sdk', 'desktop'].map((name) => {
  const child = Bun.spawn({
    cmd: [process.execPath, 'run', 'dev'],
    cwd: new URL(`../packages/${name}/`, import.meta.url).pathname,
    env: { ...process.env, GOSAI_DASHBOARD_TOKEN: token },
    stdio: ['inherit', 'pipe', 'pipe'],
  });
  void prefix(child.stdout, name, Bun.stdout);
  void prefix(child.stderr, name, Bun.stderr);
  return { name, child };
});

/** Writes every line of `stream` to `out` behind `[name]`. */
async function prefix(stream: ReadableStream<Uint8Array>, name: string, out: typeof Bun.stdout) {
  const writer = out.writer();
  let rest = '';
  for await (const chunk of stream) {
    const lines = (rest + new TextDecoder().decode(chunk)).split('\n');
    rest = lines.pop() ?? '';
    for (const line of lines) writer.write(`[${name}] ${line}\n`);
    writer.flush();
  }
  if (rest) {
    writer.write(`[${name}] ${rest}\n`);
    writer.flush();
  }
}

const stop = (signal: NodeJS.Signals) => {
  for (const { child } of processes) child.kill(signal);
};

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => stop(signal));
}

// The three belong together: when one goes down, say which and stop the rest.
const first = await Promise.race(
  processes.map(async ({ name, child }) => ({ name, code: await child.exited })),
);
console.error(`\n[dev] ${first.name} exited with code ${first.code}, stopping the others`);
stop('SIGTERM');
await Promise.all(processes.map(({ child }) => child.exited));

process.exit(first.code);
