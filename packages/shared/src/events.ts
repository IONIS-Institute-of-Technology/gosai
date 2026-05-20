/**
 * Standard event names emitted by the GOSAI server over WebSocket.
 *
 * Event names use kebab-case with namespace prefixes (e.g. `driver:event`,
 * `app:started`). Clients subscribe to specific event names or use wildcards.
 */

export const ServerEvents = {
  Welcome: 'server:welcome',
  ConfigChanged: 'server:config-changed',
  Log: 'server:log',
  PerformanceSample: 'server:performance',

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

  LogsHistory: 'logs:history',

  ConfigGet: 'config:get',
  ConfigSet: 'config:set',
} as const;

export type ClientCommandName = (typeof ClientCommands)[keyof typeof ClientCommands];
