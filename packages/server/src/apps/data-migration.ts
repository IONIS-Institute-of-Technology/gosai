/**
 * Moves per-app data out of the apps directory. Storage used to live at
 * `paths.apps/<slug>/_data/storage/` and device settings at
 * `paths.apps/<slug>/_config/settings.json`, inside the app's git checkout,
 * where uninstalling deleted them. They now live under `paths.data/<slug>/`.
 *
 * Runs at every start and only moves what is still in the old place. A file
 * that already exists at the new location wins; the old copy stays and is
 * reported.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { isValidSlug } from '@gosai/shared/slug';
import { DEVICE_SETTINGS_FILE } from '../config/app-settings.js';
import type { ChildLogger } from '../logger/logger.js';
import { appDataDir, type GosaiPaths } from '../paths.js';
import { STORAGE_DIR } from './storage.js';

const LEGACY_DATA_DIR = '_data';
const LEGACY_CONFIG_DIR = '_config';
const LEGACY_SETTINGS_FILE = 'settings.json';

export interface MigrationResult {
  readonly moved: number;
  readonly conflicts: number;
}

export function migrateLegacyAppData(
  paths: Pick<GosaiPaths, 'apps' | 'data'>,
  log: ChildLogger,
): MigrationResult {
  let moved = 0;
  let conflicts = 0;
  if (!existsSync(paths.apps)) return { moved, conflicts };

  for (const slug of readdirSync(paths.apps)) {
    if (!isValidSlug(slug)) continue;
    const appDir = join(paths.apps, slug);
    if (!isDirectory(appDir)) continue;
    const target = appDataDir(paths, slug);

    const moves: Array<[from: string, to: string]> = [];
    const legacyStorage = join(appDir, LEGACY_DATA_DIR, STORAGE_DIR);
    if (isDirectory(legacyStorage)) {
      for (const file of readdirSync(legacyStorage)) {
        if (file.endsWith('.json')) {
          moves.push([join(legacyStorage, file), join(target, STORAGE_DIR, file)]);
        }
      }
    }
    const legacySettings = join(appDir, LEGACY_CONFIG_DIR, LEGACY_SETTINGS_FILE);
    if (existsSync(legacySettings)) {
      moves.push([legacySettings, join(target, DEVICE_SETTINGS_FILE)]);
    }

    for (const [from, to] of moves) {
      if (existsSync(to)) {
        conflicts += 1;
        log.warn('kept app data already in the data directory; the old copy was left in place', {
          app: slug,
          old: from,
          current: to,
        });
        continue;
      }
      try {
        moveFile(from, to);
        moved += 1;
      } catch (err) {
        log.error('could not move app data to the data directory', {
          app: slug,
          from,
          to,
          err: String(err),
        });
      }
    }

    // Remove the old directories once empty, and the app directory too when
    // it only held data (built-in apps are installed elsewhere).
    removeIfEmpty(join(appDir, LEGACY_DATA_DIR, STORAGE_DIR));
    removeIfEmpty(join(appDir, LEGACY_DATA_DIR));
    removeIfEmpty(join(appDir, LEGACY_CONFIG_DIR));
    removeIfEmpty(appDir);
  }

  if (moved > 0)
    log.info('moved app data to the data directory', { files: moved, dir: paths.data });
  return { moved, conflicts };
}

function moveFile(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true });
  try {
    renameSync(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    copyFileSync(from, to);
    rmSync(from);
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function removeIfEmpty(dir: string): void {
  try {
    if (isDirectory(dir) && readdirSync(dir).length === 0) rmdirSync(dir);
  } catch {
    // Something else holds it; leave it.
  }
}
