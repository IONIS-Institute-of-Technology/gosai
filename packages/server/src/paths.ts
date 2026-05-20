import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

export interface GosaiPaths {
  readonly root: string;
  readonly apps: string;
  readonly logs: string;
  readonly data: string;
  readonly config: string;
}

function ensure(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function defaultPaths(): GosaiPaths {
  const override = process.env.GOSAI_HOME;
  const root = override ? resolve(override) : join(homedir(), '.gosai');
  ensure(root);
  return {
    root,
    apps: ensure(join(root, 'apps')),
    logs: ensure(join(root, 'logs')),
    data: ensure(join(root, 'data')),
    config: ensure(join(root, 'config')),
  };
}
