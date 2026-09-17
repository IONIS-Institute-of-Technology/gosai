import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { assertSlug } from '@gosai/shared/slug';

export interface GosaiPaths {
  readonly root: string;
  /** Installed apps, one git checkout per slug. */
  readonly apps: string;
  readonly logs: string;
  /** Per-app data (storage and device settings), one directory per slug. */
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

/** `paths.data/<slug>`. Kept when the app is uninstalled. */
export function appDataDir(paths: Pick<GosaiPaths, 'data'>, slug: string): string {
  return join(paths.data, assertSlug(slug, 'app slug'));
}
