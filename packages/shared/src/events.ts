/**
 * Standard event names emitted by the GOSAI server over WebSocket.
 *
 * Event names use kebab-case with namespace prefixes (e.g. `driver:event`,
 * `app:started`). Clients subscribe to specific event names or use wildcards.
 */

export const ServerEvents = {
  Welcome: 'server:welcome',
  ConfigChanged: 'server:config-changed',
  AppConfigChanged: 'app:config-changed',
  Log: 'server:log',
  PerformanceSample: 'server:performance',

  /**
   * Prefix for per-binding driver event topics. The concrete event name is
   * `driver:event:<binding>` so each app only receives its own driver stream.
   */
  DriverEvent: 'driver:event',
  DriverStateChanged: 'driver:state-changed',
  DriversListChanged: 'drivers:list-changed',

  AppInstalled: 'app:installed',
  AppUninstalled: 'app:uninstalled',
  AppsListChanged: 'apps:list-changed',
  ExperienceStateChanged: 'experience:state-changed',
  ExperiencesListChanged: 'experiences:list-changed',

  Stats: 'system:stats',
} as const;

export type ServerEventName = (typeof ServerEvents)[keyof typeof ServerEvents];

export const ClientCommands = {
  Subscribe: 'subscribe',
  Unsubscribe: 'unsubscribe',

  AppInstall: 'app:install',
  AppUninstall: 'app:uninstall',
  AppListInstalled: 'apps:list',

  ExperienceStart: 'experience:start',
  ExperienceStop: 'experience:stop',
  ExperienceList: 'experiences:list',

  DriverListAvailable: 'drivers:list',
  DriverGetData: 'driver:get-data',
  DriverExecute: 'driver:execute',
  DriverSubscribe: 'driver:subscribe',
  DriverUnsubscribe: 'driver:unsubscribe',
  DevicesList: 'devices:list',

  LogsHistory: 'logs:history',

  ConfigGet: 'config:get',
  ConfigSet: 'config:set',
  AppConfigGet: 'app:config:get',
  AppConfigSet: 'app:config:set',
} as const;

export type ClientCommandName = (typeof ClientCommands)[keyof typeof ClientCommands];
