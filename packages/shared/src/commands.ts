/**
 * What each command needs: the capability it requires, the apps and driver
 * bindings its payload touches, and how long a client should wait for the
 * reply. The request and response shapes live in `protocol-schemas.ts`.
 *
 * Zod-free, so the client can read timeouts without bundling the schemas.
 */

import { Capabilities, type Capability } from './capabilities.js';
import type { CommandName, ParsedCommandRequest } from './protocol.js';

import { SYSTEM_BINDING } from './slug.js';

export { SYSTEM_BINDING };

export interface CommandSpec<C extends CommandName> {
  /**
   * `null` when any token may run the command. `subscribe` checks each event
   * against its own capability instead.
   */
  readonly capability: Capability | null;
  /**
   * App slugs whose resources the command touches. An app token must belong
   * to every one of them, or reach it through {@link CommandSpec.target}.
   */
  readonly apps?: (payload: ParsedCommandRequest<C>) => readonly string[];
  /**
   * Driver bindings the command uses. An app token may use its own app's
   * binding and the one its window was launched with.
   */
  readonly bindings?: (payload: ParsedCommandRequest<C>) => readonly string[];
  /**
   * Lets an app token reach the app its window was launched for (the token's
   * `target`), when the token also holds this capability.
   */
  readonly target?: Capability;
  /** Client-side reply timeout. Defaults to {@link DEFAULT_REQUEST_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

const MINUTE = 60_000;

/** Waits for the bridge (1 min), then for each driver to start (up to 5 min). */
const DRIVER_START_TIMEOUT_MS = 7 * MINUTE;

const appSlug = (payload: { appSlug: string }): readonly string[] => [payload.appSlug];
const driverBinding = (payload: { binding?: string | undefined }): readonly string[] => [
  payload.binding ?? SYSTEM_BINDING,
];

export const COMMANDS: { readonly [C in CommandName]: CommandSpec<C> } = {
  subscribe: { capability: null },
  unsubscribe: { capability: null },
  'system:ping': { capability: null },

  'apps:list': { capability: Capabilities.AppsRead },
  // Clone, dependency install, build and Python requirements, each with its own limit.
  'app:install': { capability: Capabilities.AppsManage, timeoutMs: 45 * MINUTE },
  'app:uninstall': { capability: Capabilities.AppsManage, timeoutMs: 2 * MINUTE },
  'app:capabilities:set': { capability: Capabilities.AppsManage },
  'app:broadcast': { capability: Capabilities.AppEvents, apps: appSlug },
  'app:log': { capability: Capabilities.LogsWrite, apps: (p) => logSourceApps(p.source) },
  'app:settings:get': { capability: Capabilities.StorageRead, apps: appSlug },
  'app:settings:set': { capability: Capabilities.StorageWrite, apps: appSlug },
  'app:config:get': { capability: Capabilities.AppConfigRead, apps: appSlug },
  'app:config:set': {
    capability: Capabilities.AppConfigWrite,
    apps: appSlug,
    timeoutMs: 3 * MINUTE,
  },

  'experiences:list': { capability: Capabilities.ExperiencesRead },
  'experience:start': {
    capability: Capabilities.ExperiencesControl,
    apps: appSlug,
    bindings: (p) => (p.driverBinding === undefined ? [] : [p.driverBinding]),
    // Starts the required experiences and every declared driver in turn.
    timeoutMs: 15 * MINUTE,
  },
  'experience:stop': {
    capability: Capabilities.ExperiencesControl,
    apps: appSlug,
    timeoutMs: 2 * MINUTE,
  },

  'drivers:list': { capability: Capabilities.DriversRead },
  'drivers:schema': { capability: Capabilities.DriversRead },
  'devices:list': { capability: Capabilities.DevicesRead, timeoutMs: MINUTE },
  'driver:get-data': {
    capability: Capabilities.DriversUse,
    bindings: driverBinding,
    timeoutMs: MINUTE,
  },
  // The server lets an action run for two minutes.
  'driver:execute': {
    capability: Capabilities.DriversUse,
    bindings: driverBinding,
    timeoutMs: 2.5 * MINUTE,
  },
  'driver:subscribe': {
    capability: Capabilities.DriversUse,
    bindings: driverBinding,
    timeoutMs: DRIVER_START_TIMEOUT_MS,
  },
  'driver:unsubscribe': {
    capability: Capabilities.DriversUse,
    bindings: driverBinding,
    timeoutMs: 2 * MINUTE,
  },

  'logs:history': { capability: Capabilities.LogsRead },

  'config:get': { capability: Capabilities.ConfigRead },
  'config:set': { capability: Capabilities.ConfigWrite, timeoutMs: 3 * MINUTE },

  'storage:get': { capability: Capabilities.StorageRead, apps: appSlug },
  'storage:set': { capability: Capabilities.StorageWrite, apps: appSlug },
  'storage:remove': { capability: Capabilities.StorageWrite, apps: appSlug },
  'storage:list': { capability: Capabilities.StorageRead, apps: appSlug },

  'calibration:get': {
    capability: Capabilities.StorageRead,
    apps: appSlug,
    target: Capabilities.CalibrationWrite,
  },
  'calibration:save': {
    capability: Capabilities.StorageWrite,
    apps: appSlug,
    target: Capabilities.CalibrationWrite,
  },
};

export function isCommandName(value: string): value is CommandName {
  return Object.hasOwn(COMMANDS, value);
}

/**
 * The log source an app writes under names the app: `app:<slug>` or
 * `app:<slug>:<anything>`. Other sources belong to the server.
 */
export function logSourceApps(source: string): readonly string[] {
  const match = /^app:([^:]+)(?::|$)/.exec(source);
  return [match?.[1] ?? SYSTEM_BINDING];
}
