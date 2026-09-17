/**
 * Event and command names of the GOSAI server protocol.
 *
 * Event names use kebab-case with a namespace prefix. Two families are
 * parameterised: driver events arrive as `driver:event:<binding>`, and app
 * events broadcast between an app's windows as `app:<slug>:<topic>`. The
 * dashboard may also subscribe with `*` or `<namespace>:*`.
 */

import { Capabilities, type Capability } from './capabilities.js';
import type { FixedEventPayloads } from './protocol.js';

export const ServerEvents = {
  Welcome: 'server:welcome',
  ConfigChanged: 'server:config-changed',
  AppConfigChanged: 'app:config-changed',
  AppSettingsChanged: 'app:settings-changed',
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

export const ClientCommands = {
  Subscribe: 'subscribe',
  Unsubscribe: 'unsubscribe',
  Ping: 'system:ping',

  AppInstall: 'app:install',
  AppUninstall: 'app:uninstall',
  AppCapabilitiesSet: 'app:capabilities:set',
  AppListInstalled: 'apps:list',
  AppBroadcast: 'app:broadcast',
  AppLog: 'app:log',
  AppSettingsGet: 'app:settings:get',
  AppSettingsSet: 'app:settings:set',

  ExperienceStart: 'experience:start',
  ExperienceStop: 'experience:stop',
  ExperienceList: 'experiences:list',

  DriverListAvailable: 'drivers:list',
  DriverSchemas: 'drivers:schema',
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

  StorageGet: 'storage:get',
  StorageSet: 'storage:set',
  StorageRemove: 'storage:remove',
  StorageList: 'storage:list',

  CalibrationGet: 'calibration:get',
  CalibrationSave: 'calibration:save',
} as const;

/** Events with a fixed name. */
export type FixedServerEventName = Exclude<
  (typeof ServerEvents)[keyof typeof ServerEvents],
  typeof ServerEvents.DriverEvent
>;

export type DriverEventName = `driver:event:${string}`;
export type AppEventName = `app:${string}:${string}`;

/** Every event name a client can receive. */
export type ServerEventName = FixedServerEventName | DriverEventName | AppEventName;

const DRIVER_EVENT_PREFIX = `${ServerEvents.DriverEvent}:`;
const APP_EVENT = /^app:([^:]+):(.+)$/;
const FIXED_EVENTS: ReadonlySet<string> = new Set(
  Object.values(ServerEvents).filter((name) => name !== ServerEvents.DriverEvent),
);

export function driverEventName(binding: string): DriverEventName {
  return `driver:event:${binding}`;
}

export function appEventName(appSlug: string, topic: string): AppEventName {
  return `app:${appSlug}:${topic}`;
}

/** Classifies an event name. Wildcards and unknown names return `null`. */
export function parseEventName(
  name: string,
):
  | { readonly kind: 'fixed'; readonly name: FixedServerEventName }
  | { readonly kind: 'driver'; readonly binding: string }
  | { readonly kind: 'app'; readonly appSlug: string; readonly topic: string }
  | null {
  if (FIXED_EVENTS.has(name)) return { kind: 'fixed', name: name as FixedServerEventName };
  if (name.startsWith(DRIVER_EVENT_PREFIX)) {
    const binding = name.slice(DRIVER_EVENT_PREFIX.length);
    return binding === '' || binding.includes('*') ? null : { kind: 'driver', binding };
  }
  const app = APP_EVENT.exec(name);
  if (app?.[1] !== undefined && app[2] !== undefined && !name.includes('*')) {
    return { kind: 'app', appSlug: app[1], topic: app[2] };
  }
  return null;
}

/** `*` or `<namespace>:*`. */
export function isWildcardEvent(name: string): boolean {
  return name === '*' || /^[a-z-]+:\*$/.test(name);
}

/** True when a subscription pattern (exact, `ns:*` or `*`) covers `event`. */
export function eventMatches(pattern: string, event: string): boolean {
  if (pattern === '*' || pattern === event) return true;
  if (!pattern.endsWith(':*')) return false;
  const colon = event.indexOf(':');
  return colon !== -1 && event.slice(0, colon + 1) === pattern.slice(0, -1);
}

export interface EventSpec<E extends FixedServerEventName> {
  /** Needed to subscribe. `null` for events every client gets. */
  readonly capability: Capability | null;
  /** Apps an event concerns. A client only receives it for apps its token names. */
  readonly apps?: (payload: FixedEventPayloads[E]) => readonly string[];
}

/** Who may receive each fixed event. */
export const EVENTS: { readonly [E in FixedServerEventName]: EventSpec<E> } = {
  'server:welcome': { capability: null },
  'server:log': { capability: Capabilities.LogsRead },
  'server:performance': { capability: Capabilities.SystemRead },
  'server:config-changed': { capability: Capabilities.ConfigRead },
  'app:config-changed': { capability: Capabilities.AppConfigRead, apps: (p) => [p.appSlug] },
  'app:settings-changed': { capability: Capabilities.StorageRead, apps: (p) => [p.appSlug] },
  'driver:state-changed': { capability: Capabilities.DriversRead },
  'drivers:list-changed': { capability: Capabilities.DriversRead },
  'app:installed': { capability: Capabilities.AppsRead },
  'app:uninstalled': { capability: Capabilities.AppsRead },
  'apps:list-changed': { capability: Capabilities.AppsRead },
  'experience:state-changed': { capability: Capabilities.ExperiencesRead },
  'experiences:list-changed': { capability: Capabilities.ExperiencesRead },
  'system:stats': { capability: Capabilities.SystemRead },
};

/** `driver:event:<binding>` needs this capability and access to the binding's app. */
export const DRIVER_EVENT_CAPABILITY: Capability = Capabilities.DriversUse;

/** `app:<slug>:<topic>` needs this capability and access to the app. */
export const APP_EVENT_CAPABILITY: Capability = Capabilities.AppEvents;
