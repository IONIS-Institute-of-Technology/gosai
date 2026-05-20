/**
 * Per-app storage: simple JSON key/value store stored at
 * `paths.apps/<slug>/_data/storage/<key>.json`.
 *
 * Keys are sanitised to prevent path traversal. Values must be JSON-serializable.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GosaiPaths } from '../paths.js';

const KEY_PATTERN = /^[a-zA-Z0-9._-]+$/;

export class AppStorage {
  constructor(private readonly paths: GosaiPaths) {}

  get(slug: string, key: string): unknown {
    this.assertKey(key);
    const path = this.keyPath(slug, key);
    if (!existsSync(path)) return undefined;
    try {
      return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      return undefined;
    }
  }

  set(slug: string, key: string, value: unknown): void {
    this.assertKey(key);
    const dir = this.storageDir(slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(this.keyPath(slug, key), JSON.stringify(value, null, 2), 'utf8');
  }

  remove(slug: string, key: string): boolean {
    this.assertKey(key);
    const path = this.keyPath(slug, key);
    if (!existsSync(path)) return false;
    rmSync(path, { force: true });
    return true;
  }

  list(slug: string): string[] {
    const dir = this.storageDir(slug);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((entry) => entry.endsWith('.json'))
      .map((entry) => entry.replace(/\.json$/, ''));
  }

  private assertKey(key: string): void {
    if (!KEY_PATTERN.test(key)) {
      throw new Error(`Invalid storage key: ${key}`);
    }
  }

  private storageDir(slug: string): string {
    return join(this.paths.apps, slug, '_data', 'storage');
  }

  private keyPath(slug: string, key: string): string {
    return join(this.storageDir(slug), `${key}.json`);
  }
}
