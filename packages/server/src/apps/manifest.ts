/**
 * App manifest discovery and validation. Apps live in `<dir>/<slug>/` with a
 * `gosai.app.json` at the root, validated by the shared manifest schema.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AppManifest } from '@gosai/shared';
import { parseAppManifest } from '@gosai/shared/schemas';
import type { ChildLogger } from '../logger/logger.js';
import { SDK_VERSION, sdkIncompatibility } from './sdk-version.js';

export const MANIFEST_FILE = 'gosai.app.json';

export interface DiscoveredApp {
  readonly manifest: AppManifest;
  readonly installPath: string;
}

/** An app directory whose manifest doesn't parse. It can still be uninstalled. */
export interface InvalidApp {
  /** The directory name, which is the slug the app was installed under. */
  readonly slug: string;
  readonly installPath: string;
  readonly error: string;
}

export class ManifestError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = 'ManifestError';
  }
}

/**
 * Every app directory in `dir`, split into valid and invalid manifests. An
 * app whose `sdk` range excludes `sdkVersion` counts as invalid.
 */
export function discoverApps(
  dir: string,
  log: ChildLogger,
  sdkVersion: string = SDK_VERSION,
): { apps: DiscoveredApp[]; invalid: InvalidApp[] } {
  const out: DiscoveredApp[] = [];
  const invalid: InvalidApp[] = [];
  if (!existsSync(dir)) return { apps: out, invalid };
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.')) continue;
    const appDir = join(dir, entry);
    try {
      if (!statSync(appDir).isDirectory()) continue;
    } catch {
      continue;
    }
    const manifestPath = join(appDir, MANIFEST_FILE);
    if (!existsSync(manifestPath)) continue;
    try {
      const manifest = parseManifest(manifestPath, (warning) =>
        log.warn(`manifest warning: ${warning}`, { path: manifestPath }),
      );
      const incompatible = sdkIncompatibility(manifest, sdkVersion);
      if (incompatible) throw new ManifestError(manifestPath, incompatible);
      out.push({ manifest, installPath: appDir });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.warn('app has an invalid manifest', { path: manifestPath, err: error });
      invalid.push({ slug: entry, installPath: appDir, error });
    }
  }
  return { apps: out, invalid };
}

export function parseManifest(path: string, onWarning?: (warning: string) => void): AppManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new ManifestError(path, `invalid JSON: ${String(err)}`);
  }
  return validateManifest(path, raw, onWarning);
}

/** Throws a ManifestError for an invalid manifest; ignored fields go to `onWarning`. */
export function validateManifest(
  path: string,
  value: unknown,
  onWarning?: (warning: string) => void,
): AppManifest {
  const result = parseAppManifest(value);
  if (!result.success) throw new ManifestError(path, result.error);
  for (const warning of result.warnings) onWarning?.(warning);
  return result.data;
}
