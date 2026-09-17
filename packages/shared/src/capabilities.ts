/**
 * Capabilities gate every server command and event. The dashboard token holds
 * all of them. An app token holds the default ones plus whatever the app's
 * manifest requests, and only for the apps the token names.
 */

export const Capabilities = {
  AppsRead: 'apps:read',
  AppsManage: 'apps:manage',
  ExperiencesRead: 'experiences:read',
  ExperiencesControl: 'experiences:control',
  DriversRead: 'drivers:read',
  DriversUse: 'drivers:use',
  DevicesRead: 'devices:read',
  ConfigRead: 'config:read',
  ConfigWrite: 'config:write',
  AppConfigRead: 'app-config:read',
  AppConfigWrite: 'app-config:write',
  StorageRead: 'storage:read',
  StorageWrite: 'storage:write',
  AppEvents: 'app-events:use',
  LogsRead: 'logs:read',
  LogsWrite: 'logs:write',
  SystemRead: 'system:read',
  EventsWildcard: 'events:wildcard',
} as const;

export type Capability = (typeof Capabilities)[keyof typeof Capabilities];

/**
 * How an app gets a capability:
 * - `default`: every app token has it.
 * - `request`: the app lists it in its manifest's `capabilities`.
 * - `dashboard`: only the dashboard token has it.
 */
export type CapabilityGrant = 'default' | 'request' | 'dashboard';

export interface CapabilityInfo {
  readonly grant: CapabilityGrant;
  /** One line for the install prompt. */
  readonly description: string;
}

export const CAPABILITY_INFO: Readonly<Record<Capability, CapabilityInfo>> = {
  'apps:read': { grant: 'default', description: 'List installed apps and their manifests' },
  'apps:manage': { grant: 'dashboard', description: 'Install and uninstall apps' },
  'experiences:read': { grant: 'default', description: 'See which experiences are running' },
  'experiences:control': {
    grant: 'default',
    description: "Start and stop the app's own experiences",
  },
  'drivers:read': { grant: 'default', description: 'List drivers and their state' },
  'drivers:use': {
    grant: 'default',
    description: "Subscribe to and control drivers bound to the app's apps",
  },
  'devices:read': {
    grant: 'request',
    description: 'Enumerate cameras, microphones and speakers',
  },
  'config:read': { grant: 'default', description: 'Read the global configuration' },
  'config:write': { grant: 'dashboard', description: 'Change the global configuration' },
  'app-config:read': { grant: 'default', description: "Read the app's device assignments" },
  'app-config:write': { grant: 'request', description: "Change the app's device assignments" },
  'storage:read': { grant: 'default', description: "Read the app's storage and settings" },
  'storage:write': { grant: 'default', description: "Write the app's storage and settings" },
  'app-events:use': {
    grant: 'default',
    description: "Send and receive the app's events between windows",
  },
  'logs:read': { grant: 'request', description: 'Read the server log, including other apps' },
  'logs:write': { grant: 'default', description: 'Write to the server log' },
  'system:read': { grant: 'default', description: 'Read CPU, memory and performance samples' },
  'events:wildcard': {
    grant: 'dashboard',
    description: 'Subscribe to every event with a wildcard',
  },
};

export const ALL_CAPABILITIES: readonly Capability[] = Object.keys(CAPABILITY_INFO) as Capability[];

export const DEFAULT_APP_CAPABILITIES: readonly Capability[] = ALL_CAPABILITIES.filter(
  (capability) => CAPABILITY_INFO[capability].grant === 'default',
);

/** Capabilities a manifest may request. */
export const REQUESTABLE_CAPABILITIES: readonly Capability[] = ALL_CAPABILITIES.filter(
  (capability) => CAPABILITY_INFO[capability].grant === 'request',
);

export function isCapability(value: unknown): value is Capability {
  return typeof value === 'string' && Object.hasOwn(CAPABILITY_INFO, value);
}
