/**
 * `bun run dev`: starts the server, the SDK watcher and the desktop app with
 * one dashboard token, so the separately started server accepts the desktop
 * windows. Set GOSAI_DASHBOARD_TOKEN to choose the token yourself.
 *
 * One `bun run --filter` per package, not one run with three filters: a single
 * run holds a package back until the scripts of the packages it depends on
 * exit, and the SDK watcher never exits, so the server would never start.
 */

import { generateDashboardToken } from '@gosai/shared/auth';

const token = process.env.GOSAI_DASHBOARD_TOKEN || generateDashboardToken();

const children = ['@gosai/sdk', '@gosai/server', '@gosai/desktop'].map((pkg) =>
  Bun.spawn({
    cmd: [process.execPath, 'run', '--elide-lines=0', '--filter', pkg, 'dev'],
    env: { ...process.env, GOSAI_DASHBOARD_TOKEN: token },
    stdio: ['inherit', 'inherit', 'inherit'],
  }),
);

const stop = (signal: NodeJS.Signals) => {
  for (const child of children) child.kill(signal);
};

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => stop(signal));
}

// The three belong together: when one goes down, take the others with it.
const code = await Promise.race(children.map((child) => child.exited));
stop('SIGTERM');
await Promise.all(children.map((child) => child.exited));

process.exit(code);
