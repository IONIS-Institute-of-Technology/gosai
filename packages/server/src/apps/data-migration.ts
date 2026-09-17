/**
 * Moves per-app data out of the apps directory. Storage used to live at
 * `paths.apps/<slug>/_data/storage/` and device settings at
 * `paths.apps/<slug>/_config/settings.json`, inside the app's git checkout,
 * where uninstalling deleted them. They now live under `paths.data/<slug>/`.
 *
 * App checkouts are third-party code, so the migration never follows a
 * symlink: every directory on the way and every file must be the real thing
 * and stay inside the app's directory. Anything else is left alone and
 * reported. A file that already exists at the new location wins; the old copy
 * stays and is reported.
 *
 * Once an app's old data is handled, a marker in its data directory stops
 * the migration from looking at it again.
 */

import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { dirname, join, relative, isAbsolute, sep } from 'node:path';
import { isValidSlug } from '@gosai/shared/slug';
import { DEVICE_SETTINGS_FILE } from '../config/app-settings.js';
import type { ChildLogger } from '../logger/logger.js';
import { appDataDir, type GosaiPaths } from '../paths.js';
import { STORAGE_DIR } from './storage.js';

const LEGACY_DATA_DIR = '_data';
const LEGACY_CONFIG_DIR = '_config';
const LEGACY_SETTINGS_FILE = 'settings.json';
export const MIGRATED_MARKER = '.legacy-data-migrated';

export interface MigrationResult {
  readonly moved: number;
  readonly conflicts: number;
  /** Symlinks and other entries that aren't plain files or directories. */
  readonly skipped: number;
}

export function migrateLegacyAppData(
  paths: Pick<GosaiPaths, 'apps' | 'data'>,
  log: ChildLogger,
): MigrationResult {
  const result = { moved: 0, conflicts: 0, skipped: 0 };
  if (lstatOrNull(paths.apps)?.isDirectory() !== true) return result;

  for (const slug of readdirSync(paths.apps)) {
    if (!isValidSlug(slug)) continue;
    const appDir = join(paths.apps, slug);
    if (lstatOrNull(appDir)?.isDirectory() !== true) continue;
    const dataDir = appDataDir(paths, slug);
    if (lstatOrNull(join(dataDir, MIGRATED_MARKER))) continue;

    let skipped = 0;
    const skip = (path: string, reason: string): void => {
      skipped += 1;
      result.skipped += 1;
      log.warn('left legacy app data in place', { app: slug, path, reason });
    };
    const appRoot = realpathSync(appDir);
    const moves: Array<[from: string, to: string]> = [];

    const legacyData = join(appDir, LEGACY_DATA_DIR);
    const legacyStorage = join(legacyData, STORAGE_DIR);
    if (realDirectory(legacyData, skip) && realDirectory(legacyStorage, skip)) {
      for (const file of readdirSync(legacyStorage)) {
        if (!file.endsWith('.json')) continue;
        const from = join(legacyStorage, file);
        if (plainFileInside(from, appRoot, skip)) {
          moves.push([from, join(dataDir, STORAGE_DIR, file)]);
        }
      }
    }
    const legacyConfig = join(appDir, LEGACY_CONFIG_DIR);
    const legacySettings = join(legacyConfig, LEGACY_SETTINGS_FILE);
    if (
      realDirectory(legacyConfig, skip) &&
      lstatOrNull(legacySettings) &&
      plainFileInside(legacySettings, appRoot, skip)
    ) {
      moves.push([legacySettings, join(dataDir, DEVICE_SETTINGS_FILE)]);
    }

    let failed = false;
    for (const [from, to] of moves) {
      if (lstatOrNull(to)) {
        result.conflicts += 1;
        log.warn('kept app data already in the data directory; the old copy was left in place', {
          app: slug,
          old: from,
          current: to,
        });
        continue;
      }
      try {
        moveFile(from, to);
        result.moved += 1;
      } catch (err) {
        failed = true;
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
    removeEmptyDirectory(legacyStorage);
    removeEmptyDirectory(legacyData);
    removeEmptyDirectory(legacyConfig);
    removeEmptyDirectory(appDir);

    // Only apps that had old data get a marker, so installed apps without any
    // don't gain a data directory. A failed move is tried again next start.
    if (!failed && moves.length + skipped > 0) {
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(join(dataDir, MIGRATED_MARKER), `${new Date().toISOString()}\n`);
    }
  }

  if (result.moved > 0) {
    log.info('moved app data to the data directory', { files: result.moved, dir: paths.data });
  }
  return result;
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

/** A directory that exists and isn't a symlink. Anything else present is reported. */
function realDirectory(path: string, skip: (path: string, reason: string) => void): boolean {
  const stats = lstatOrNull(path);
  if (!stats) return false;
  if (stats.isDirectory()) return true;
  skip(path, stats.isSymbolicLink() ? 'symlink' : 'not a directory');
  return false;
}

/** A regular file (not a symlink) whose real path stays inside `root`. */
function plainFileInside(
  path: string,
  root: string,
  skip: (path: string, reason: string) => void,
): boolean {
  const stats = lstatOrNull(path);
  if (!stats?.isFile()) {
    skip(path, stats?.isSymbolicLink() ? 'symlink' : 'not a regular file');
    return false;
  }
  const rel = relative(root, realpathSync(path));
  if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) {
    skip(path, 'outside the app directory');
    return false;
  }
  return true;
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

/** Removes `dir` when it is a real, empty directory. Returns whether it did. */
function removeEmptyDirectory(dir: string): boolean {
  try {
    if (!lstatSync(dir).isDirectory() || readdirSync(dir).length > 0) return false;
    rmdirSync(dir);
    return true;
  } catch {
    return false;
  }
}
