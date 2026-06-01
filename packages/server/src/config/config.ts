/**
 * Global GOSAI configuration. Persisted as JSON under `paths.config/global.json`.
 * Per-app config lives under `paths.apps/<slug>/config.json` (managed by the app).
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CameraSettings, GlobalConfig } from '@gosai/shared';
import type { EventBus } from '../ipc/index.js';
import type { ChildLogger } from '../logger/index.js';

const CONFIG_FILE = 'global.json';

const DEFAULT_CAMERA: CameraSettings = {
  device: 0,
  width: 1280,
  height: 720,
  fps: 30,
};

const DEFAULT_CONFIG: GlobalConfig = {
  displayId: null,
  serverPort: 7777,
  autoStartApps: [],
  camera: DEFAULT_CAMERA,
};

export class ConfigStore {
  private state: GlobalConfig;
  private readonly path: string;

  constructor(
    configDir: string,
    private readonly bus: EventBus,
    private readonly log: ChildLogger,
  ) {
    this.path = join(configDir, CONFIG_FILE);
    this.state = this.load();
  }

  get(): GlobalConfig {
    return this.state;
  }

  update(patch: Partial<GlobalConfig>): GlobalConfig {
    const next: GlobalConfig = {
      ...this.state,
      ...patch,
      autoStartApps:
        patch.autoStartApps !== undefined ? [...patch.autoStartApps] : this.state.autoStartApps,
      camera:
        patch.camera !== undefined ? { ...this.state.camera, ...patch.camera } : this.state.camera,
    };
    this.state = next;
    this.persist();
    this.bus.emit('server:config-changed', next, 'config');
    return next;
  }

  private load(): GlobalConfig {
    if (!existsSync(this.path)) {
      this.state = DEFAULT_CONFIG;
      try {
        writeFileSync(this.path, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf8');
      } catch (err) {
        this.log.warn('could not persist default config', { err: String(err) });
      }
      return DEFAULT_CONFIG;
    }
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<GlobalConfig>;
      return {
        ...DEFAULT_CONFIG,
        ...raw,
        autoStartApps: raw.autoStartApps ?? DEFAULT_CONFIG.autoStartApps,
        camera: { ...DEFAULT_CAMERA, ...raw.camera },
      };
    } catch (err) {
      this.log.warn('config file is corrupt, falling back to defaults', { err: String(err) });
      return DEFAULT_CONFIG;
    }
  }

  private persist(): void {
    try {
      writeFileSync(this.path, JSON.stringify(this.state, null, 2), 'utf8');
    } catch (err) {
      this.log.error('failed to persist config', { err: String(err) });
    }
  }
}
