/**
 * `bun run dev`: starts the server, the SDK watcher and the desktop app with
 * one dashboard token, so the separately started server accepts the desktop
 * windows. Set GOSAI_DASHBOARD_TOKEN to choose the token yourself.
 */

import { generateDashboardToken } from '@gosai/shared/auth';

const token = process.env.GOSAI_DASHBOARD_TOKEN || generateDashboardToken();

const child = Bun.spawn({
  cmd: [
    process.execPath,
    'run',
    '--elide-lines=0',
    '--filter',
    '@gosai/server',
    '--filter',
    '@gosai/sdk',
    '--filter',
    '@gosai/desktop',
    'dev',
  ],
  env: { ...process.env, GOSAI_DASHBOARD_TOKEN: token },
  stdio: ['inherit', 'inherit', 'inherit'],
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => child.kill(signal));
}

process.exit(await child.exited);
