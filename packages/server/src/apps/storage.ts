/**
 * Per-app key/value storage: one JSON file per key at
 * `paths.data/<slug>/storage/<key>.json`. Keys are checked against the
 * protocol's storage key pattern, so they can't leave the directory.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { STORAGE_KEY_PATTERN } from '@gosai/shared/schemas';
import { writeJsonAtomic } from '../config/config.js';
import { appDataDir, type GosaiPaths } from '../paths.js';

export const STORAGE_DIR = 'storage';

export type StoredValue =
  { readonly found: true; readonly value: unknown } | { readonly found: false };

export class AppStorage {
  constructor(private readonly paths: Pick<GosaiPaths, 'data'>) {}

  /** Throws when the stored file isn't valid JSON, rather than hiding the value. */
  get(slug: string, key: string): StoredValue {
    const path = this.keyPath(slug, key);
    if (!existsSync(path)) return { found: false };
    try {
      return { found: true, value: JSON.parse(readFileSync(path, 'utf8')) as unknown };
    } catch (err) {
      throw new Error(`Stored value ${key} of ${slug} is corrupt: ${String(err)}`);
    }
  }

  set(slug: string, key: string, value: unknown): void {
    const path = this.keyPath(slug, key);
    mkdirSync(this.storageDir(slug), { recursive: true });
    writeJsonAtomic(path, value === undefined ? null : value);
  }

  remove(slug: string, key: string): boolean {
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
      .map((entry) => entry.slice(0, -'.json'.length))
      .filter((key) => STORAGE_KEY_PATTERN.test(key))
      .sort();
  }

  private storageDir(slug: string): string {
    return join(appDataDir(this.paths, slug), STORAGE_DIR);
  }

  private keyPath(slug: string, key: string): string {
    if (!STORAGE_KEY_PATTERN.test(key)) throw new Error(`Invalid storage key: ${key}`);
    return join(this.storageDir(slug), `${key}.json`);
  }
}
