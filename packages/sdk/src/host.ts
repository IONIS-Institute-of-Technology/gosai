/**
 * @gosai/sdk/host - for code that hosts experiences rather than being one:
 * the GOSAI app host page, test harnesses and custom shells.
 *
 * App code imports `@gosai/sdk` instead.
 */

export {
  runExperience,
  startRuntime,
  DEFAULT_MAX_DELTA_MS,
  DEFAULT_MAX_RENDER_FAILURES,
} from './runtime.js';
export type {
  FrameScheduler,
  RuntimeEnvironment,
  RuntimeHandle,
  RuntimeOptions,
} from './runtime.js';

export { bootAppHost, readLaunchParams } from './app-host-page.js';
export { appHostname, appSlugFromHostname } from '@gosai/shared/app-origin';
export type { AppHostControl, LaunchParams } from './app-host-page.js';

export { ServerClient } from './connection.js';
export type { ConnectionStatus, ServerClientOptions } from './connection.js';

export type { SettingsBackend } from './settings.js';

export { PROTOCOL_VERSION } from '@gosai/shared/protocol';
export { ServerEvents, ClientCommands } from '@gosai/shared/events';
export type {
  DisplayInfo,
  GlobalConfig,
  LogEntry,
  PerformanceSample,
  SystemStats,
} from '@gosai/shared';
