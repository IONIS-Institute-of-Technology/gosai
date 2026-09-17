import type { CalibrationStore } from '../apps/calibration.js';
import type { AppManager } from '../apps/manager.js';
import type { AppSettingsValuesStore } from '../apps/settings.js';
import type { AppStorage } from '../apps/storage.js';
import type { AppSettingsStore } from '../config/app-settings.js';
import type { ConfigStore } from '../config/config.js';
import type { DriverService } from '../drivers/hub.js';
import type { EventBus } from '../ipc/bus.js';
import type { Logger } from '../logger/logger.js';

/** The services command handlers work with. */
export interface ServerServices {
  readonly apps: AppManager;
  readonly drivers: DriverService;
  readonly config: ConfigStore;
  readonly deviceSettings: AppSettingsStore;
  readonly settings: AppSettingsValuesStore;
  readonly storage: AppStorage;
  readonly calibration: CalibrationStore;
  readonly logger: Logger;
  readonly bus: EventBus;
}
