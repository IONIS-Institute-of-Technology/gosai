/**
 * App manifest discovery and validation. Apps live in `<dir>/<slug>/` with a
 * `gosai.app.json` at the root, validated by the shared manifest schema.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AppManifest } from '@gosai/shared';
import { parseAppManifest } from '@gosai/shared/schemas';
import type { ChildLogger } from '../logger/logger.js';

export const MANIFEST_FILE = 'gosai.app.json';

export interface DiscoveredApp {
  readonly manifest: AppManifest;
  readonly installPath: string;
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

/** Every app directory in `dir` with a valid manifest. Invalid ones are logged. */
export function discoverApps(dir: string, log: ChildLogger): DiscoveredApp[] {
  if (!existsSync(dir)) return [];
  const out: DiscoveredApp[] = [];
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
      out.push({ manifest: parseManifest(manifestPath), installPath: appDir });
    } catch (err) {
      log.warn('skipping app with an invalid manifest', {
        path: manifestPath,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}

export function parseManifest(path: string): AppManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new ManifestError(path, `invalid JSON: ${String(err)}`);
  }
  return validateManifest(path, raw);
}

export function validateManifest(path: string, value: unknown): AppManifest {
  const result = parseAppManifest(value);
  if (!result.success) throw new ManifestError(path, result.error);
  return result.data;
}
