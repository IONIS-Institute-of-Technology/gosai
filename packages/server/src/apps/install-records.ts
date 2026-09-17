/**
 * What the server remembers about an installed app, next to its data at
 * `paths.data/<slug>/install.json`: where it was installed from and which of
 * its requested capabilities were approved. The record stays with the data
 * when the app is uninstalled, so a different app that later takes the same
 * slug doesn't silently inherit either.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { isCapability, type Capability } from '@gosai/shared/capabilities';
import { writeJsonAtomic } from '../config/config.js';
import type { ChildLogger } from '../logger/logger.js';
import { appDataDir, type GosaiPaths } from '../paths.js';

export const INSTALL_RECORD_FILE = 'install.json';

export interface InstallRecord {
  /** The git source the app was installed from. */
  readonly source: string;
  /** Requested capabilities the operator approved. */
  readonly approvedCapabilities: readonly Capability[];
  readonly installedAt: number;
}

const recordSchema = z.object({
  source: z.string(),
  approvedCapabilities: z.array(z.string()).transform((list) => list.filter(isCapability)),
  installedAt: z.number(),
}) satisfies z.ZodType<InstallRecord, unknown>;

export class InstallRecords {
  constructor(
    private readonly paths: Pick<GosaiPaths, 'data'>,
    private readonly log: ChildLogger,
  ) {}

  get(slug: string): InstallRecord | undefined {
    const path = this.path(slug);
    if (!existsSync(path)) return undefined;
    try {
      const parsed = recordSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
      if (parsed.success) return parsed.data;
    } catch {
      // Reported below.
    }
    this.log.warn('ignoring an invalid install record', { app: slug, path });
    return undefined;
  }

  set(slug: string, record: InstallRecord): void {
    mkdirSync(appDataDir(this.paths, slug), { recursive: true });
    writeJsonAtomic(this.path(slug), record);
  }

  private path(slug: string): string {
    return join(appDataDir(this.paths, slug), INSTALL_RECORD_FILE);
  }
}

/** `remote.origin.url` of a git checkout, or `null`. */
export function gitOrigin(dir: string): string | null {
  const result = Bun.spawnSync({
    cmd: ['git', '-C', dir, 'config', '--get', 'remote.origin.url'],
    stdout: 'pipe',
    stderr: 'ignore',
  });
  const url = result.exitCode === 0 ? result.stdout.toString().trim() : '';
  return url === '' ? null : url;
}
