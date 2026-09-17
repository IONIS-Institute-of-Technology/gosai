/**
 * Global GOSAI configuration, persisted as JSON under `paths.config/global.json`.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GlobalConfig, GlobalConfigPatch } from '@gosai/shared';
import { ServerEvents } from '@gosai/shared/events';
import {
  DEFAULT_GLOBAL_CONFIG,
  formatZodError,
  globalConfigFileSchema,
} from '@gosai/shared/schemas';
import type { EventBus } from '../ipc/bus.js';
import type { ChildLogger } from '../logger/logger.js';

const CONFIG_FILE = 'global.json';

export interface LoadedConfig {
  readonly config: GlobalConfig;
  /** Why the file was ignored, when it was. */
  readonly problem?: string;
}

/** Reads `global.json`, filling in defaults. A corrupt file yields the defaults. */
export function loadGlobalConfig(configDir: string): LoadedConfig {
  const path = join(configDir, CONFIG_FILE);
  if (!existsSync(path)) return { config: DEFAULT_GLOBAL_CONFIG };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    return { config: DEFAULT_GLOBAL_CONFIG, problem: `invalid JSON: ${String(err)}` };
  }
  const parsed = globalConfigFileSchema.safeParse(raw);
  if (!parsed.success) {
    return { config: DEFAULT_GLOBAL_CONFIG, problem: formatZodError(parsed.error) };
  }
  return { config: parsed.data };
}

/** Writes JSON through a temporary file so a crash never leaves half a file. */
export function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
}

export class ConfigStore {
  private state: GlobalConfig;
  private readonly path: string;

  constructor(
    configDir: string,
    private readonly bus: EventBus,
    private readonly log: ChildLogger,
  ) {
    this.path = join(configDir, CONFIG_FILE);
    const loaded = loadGlobalConfig(configDir);
    if (loaded.problem) {
      log.warn('global config is invalid, using defaults until it is saved again', {
        path: this.path,
        problem: loaded.problem,
      });
    }
    this.state = loaded.config;
  }

  get(): GlobalConfig {
    return this.state;
  }

  update(patch: GlobalConfigPatch): GlobalConfig {
    const next: GlobalConfig = {
      displayId: patch.displayId !== undefined ? patch.displayId : this.state.displayId,
      serverPort: patch.serverPort ?? this.state.serverPort,
      autoStartApps: patch.autoStartApps ? [...patch.autoStartApps] : this.state.autoStartApps,
      camera: patch.camera ? { ...this.state.camera, ...patch.camera } : this.state.camera,
    };
    this.state = next;
    try {
      writeJsonAtomic(this.path, next);
    } catch (err) {
      this.log.error('failed to persist config', { err: String(err) });
    }
    this.bus.emit(ServerEvents.ConfigChanged, next, 'config');
    return next;
  }
}
