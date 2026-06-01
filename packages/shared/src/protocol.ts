/**
 * WebSocket message protocol shared between server, desktop, and apps.
 *
 * All messages are JSON-serializable. Binary payloads (frames, audio) use
 * base64 strings inside the JSON envelope or, when efficiency matters, are
 * sent as separate binary frames with the `id` referencing this envelope.
 */

import type {
  AppDeviceSettings,
  AppDeviceSettingsPatch,
  DeviceCatalog,
  DriverInfo,
  GlobalConfig,
  InstalledApp,
  LogEntry,
  PerformanceSample,
  RunningExperience,
  SystemStats,
} from './types.js';

export const PROTOCOL_VERSION = 1;

export interface MessageEnvelope<TType extends string = string, TPayload = unknown> {
  readonly v: typeof PROTOCOL_VERSION;
  readonly id?: string;
  readonly type: TType;
  readonly payload: TPayload;
  readonly ts?: number;
}

export interface ErrorPayload {
  readonly code: string;
  readonly message: string;
  readonly details?: unknown;
}

export type ServerMessage =
  | MessageEnvelope<
      'server:welcome',
      { protocolVersion: number; serverVersion: string; clientId: string }
    >
  | MessageEnvelope<'server:log', LogEntry>
  | MessageEnvelope<'server:performance', PerformanceSample>
  | MessageEnvelope<'server:config-changed', GlobalConfig>
  | MessageEnvelope<'app:config-changed', { appSlug: string; settings: AppDeviceSettings }>
  | MessageEnvelope<
      // Driver events are routed per binding: the concrete event name is
      // `driver:event:<binding>` so clients only receive their own app's stream.
      `driver:event:${string}`,
      { driver: string; event: string; data: unknown; ts: number; binding: string }
    >
  | MessageEnvelope<'driver:state-changed', DriverInfo>
  | MessageEnvelope<'drivers:list-changed', { drivers: DriverInfo[] }>
  | MessageEnvelope<'app:installed', InstalledApp>
  | MessageEnvelope<'app:uninstalled', { slug: string }>
  | MessageEnvelope<'apps:list-changed', { apps: InstalledApp[] }>
  | MessageEnvelope<'experience:state-changed', RunningExperience>
  | MessageEnvelope<'experiences:list-changed', { experiences: RunningExperience[] }>
  | MessageEnvelope<'system:stats', SystemStats>
  | MessageEnvelope<'response', { requestId: string; ok: true; data: unknown }>
  | MessageEnvelope<'response', { requestId: string; ok: false; error: ErrorPayload }>;

export type ClientMessage =
  | MessageEnvelope<'subscribe', { events: string[] }>
  | MessageEnvelope<'unsubscribe', { events: string[] }>
  | MessageEnvelope<'app:install', { source: string }>
  | MessageEnvelope<'app:uninstall', { slug: string }>
  | MessageEnvelope<'apps:list', Record<string, never>>
  | MessageEnvelope<'experience:start', { appSlug: string; experienceSlug: string }>
  | MessageEnvelope<'experience:stop', { appSlug: string; experienceSlug: string }>
  | MessageEnvelope<'experiences:list', Record<string, never>>
  | MessageEnvelope<'drivers:list', Record<string, never>>
  // `binding` identifies the requesting app (its slug) so the server can route
  // to the right per-app driver instance. Omitted => the `system` binding.
  | MessageEnvelope<'driver:get-data', { driver: string; event: string; binding?: string }>
  | MessageEnvelope<
      'driver:execute',
      { driver: string; action: string; data?: unknown; binding?: string }
    >
  | MessageEnvelope<'driver:subscribe', { driver: string; event: string; binding?: string }>
  | MessageEnvelope<'driver:unsubscribe', { driver: string; event: string; binding?: string }>
  | MessageEnvelope<'devices:list', Record<string, never>>
  | MessageEnvelope<'logs:history', { limit?: number; level?: string }>
  | MessageEnvelope<'config:get', Record<string, never>>
  | MessageEnvelope<'config:set', Partial<GlobalConfig>>
  | MessageEnvelope<'app:config:get', { appSlug: string }>
  | MessageEnvelope<'app:config:set', { appSlug: string; settings: AppDeviceSettingsPatch }>;

/** Response payload for `devices:list`. */
export type DeviceListResult = DeviceCatalog;

/**
 * Python <-> Server bridge protocol (stdio newline-delimited JSON).
 */
export type BridgeRequest =
  | { type: 'ping'; id: string }
  | { type: 'list-drivers'; id: string }
  | { type: 'list-cameras'; id: string }
  | { type: 'list-audio-devices'; id: string }
  | {
      type: 'start-driver';
      id: string;
      instance: string;
      driver: string;
      config?: Record<string, unknown>;
    }
  | { type: 'stop-driver'; id: string; instance: string; driver: string }
  | { type: 'subscribe'; id: string; instance: string; driver: string; event: string }
  | { type: 'unsubscribe'; id: string; instance: string; driver: string; event: string }
  | { type: 'get-data'; id: string; instance: string; driver: string; event: string }
  | { type: 'execute'; id: string; instance: string; driver: string; action: string; data?: unknown }
  | { type: 'shutdown'; id: string };

export type BridgeResponse =
  | { type: 'pong'; id: string; ts: number }
  | { type: 'result'; id: string; ok: true; data?: unknown }
  | { type: 'result'; id: string; ok: false; error: string }
  | { type: 'event'; instance: string; driver: string; event: string; data: unknown; ts: number }
  | { type: 'log'; level: string; source: string; message: string; ts: number }
  | { type: 'driver-state'; instance: string; driver: string; state: string }
  | { type: 'performance'; source: string; metric: string; value: number; ts: number }
  | { type: 'ready'; version: string };

export interface BridgeManifest {
  readonly drivers: readonly {
    readonly name: string;
    readonly events: readonly string[];
    readonly actions: readonly string[];
    readonly dependencies: readonly string[];
    readonly description?: string;
    readonly shared?: boolean;
  }[];
}
