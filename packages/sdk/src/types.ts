/**
 * Types for app code: the experience definition and the runtime context the
 * lifecycle hooks receive.
 */

import type {
  AppDeviceSettings,
  AppManifest,
  ExperienceDescriptor,
  RunningExperience,
} from '@gosai/shared';
import type { ServerClient } from '@gosai/shared/client';
import type {
  DriverAction,
  DriverActionArgs,
  DriverActionResult,
  DriverEvent,
  DriverEventData,
  DriverName,
  KnownDriverName,
} from './driver-types.js';

export type {
  AppDeviceSettings,
  AppManifest,
  AppCalibrationSchema,
  AppRequirements,
  AppSettingsSchema,
  AppSettingsGroup,
  AppSettingsField,
  AppSettingsFieldType,
  AppSettingsOption,
  ExperienceDescriptor,
  PythonConfig,
  InstalledApp,
  RunningExperience,
  DriverInfo,
  DriverInstanceInfo,
  DriverRuntimeInfo,
  DriverState,
  LogLevel,
  ExperienceState,
  AppState,
} from '@gosai/shared';

export interface AppContext {
  readonly appSlug: string;
  readonly experienceSlug: string;
  /** The app's manifest, as the server parsed it. */
  readonly manifest: AppManifest;
  /** This experience's entry in the manifest: name, description, drivers. */
  readonly experience: ExperienceDescriptor;
  /**
   * Launch parameters the window was opened with, such as `role` and
   * `target` for calibration windows (see `readCalibrationLaunch`). The
   * access token is never included.
   */
  readonly params: Readonly<Record<string, string>>;
  /** Underlying server connection, for commands the SDK doesn't wrap. */
  readonly server: ServerConnection;
  /** HTTP origin of the server for this app, e.g. `http://my-app.localhost:7777`. */
  readonly serverBaseUrl: string;
}

/** The typed server connection. Every command and event is in `@gosai/shared/protocol`. */
export type ServerConnection = Pick<
  ServerClient,
  'authToken' | 'connected' | 'request' | 'on' | 'onStatus' | 'onError' | 'retain' | 'serverInfo'
>;

export interface ExperienceRuntimeContext {
  readonly app: AppContext;
  /**
   * Driver events and actions for this app's driver binding. Subscriptions
   * still open when the experience stops are removed by the runtime.
   */
  readonly drivers: DriverClient;
  readonly storage: StorageClient;
  /** The app's settings from its manifest `settings` schema. */
  readonly settings: SettingsClient;
  /** URLs of files shipped with the app. */
  readonly assets: AssetsClient;
  readonly log: AppLogger;
  readonly router: ExperienceRouter;
  /**
   * App-scoped pub/sub. Useful when an experience runs in several windows
   * (e.g. projector and control windows) that need to coordinate state.
   * Subscriptions still open when the experience stops are removed.
   */
  readonly events: AppEventsClient;
  /** The app's device assignments and their changes. */
  readonly appConfig: AppConfigClient;
  /**
   * Aborts when the experience stops. Pass it to `addEventListener`, `fetch`
   * and anything else that accepts a signal so it is released automatically.
   */
  readonly signal: AbortSignal;
  /**
   * An AudioContext the runtime owns. Created on first use, resumed when the
   * experience starts and closed when it stops.
   */
  readonly audio: AudioContext;
  /** Measures one round trip to the server, in milliseconds. */
  ping(): Promise<number>;
}

/** Short name for the runtime context. */
export type ExperienceContext = ExperienceRuntimeContext;

export interface AppEventsSubscription {
  unsubscribe(): void;
}

export interface AppEventsClient {
  /** Broadcast a topic to every other window listening on it for this app. */
  emit(topic: string, data?: unknown): Promise<void>;
  /** Subscribe to a topic emitted by any window for this app. */
  on(topic: string, listener: (data: unknown) => void): AppEventsSubscription;
}

export interface DriverSubscription {
  /**
   * Settles once the server confirmed the first subscription attempt. A failure
   * is also logged, and the subscription is tried again after a reconnect.
   */
  readonly ready: Promise<void>;
  unsubscribe(): void;
}

export interface AppConfigClient {
  /** The app's device assignments: display, camera, microphone and speaker overrides. */
  get(): Promise<AppDeviceSettings>;
  /** Called when the dashboard changes them. Removed when the experience stops. */
  onChange(listener: (settings: AppDeviceSettings) => void): () => void;
}

/**
 * Driver events and actions. Data is typed for the drivers in
 * `DriverRegistry` and `unknown` for any other driver.
 */
export interface DriverClient {
  /** Subscribe to an event of a driver, or to all of them with `'*'`. */
  on<D extends DriverName, E extends DriverEvent<D> | '*'>(
    driver: D,
    event: E,
    listener: (data: DriverEventData<D, E>) => void,
  ): DriverSubscription;
  /** The most recent value of a driver event, or `null` before the first one. */
  get<D extends DriverName, E extends DriverEvent<D>>(
    driver: D,
    event: E,
  ): Promise<DriverEventData<D, E> | null>;
  /**
   * @deprecated Casts the value of a driver the SDK doesn't know. Generate
   * its types with `gosai-sdk gen-driver-types` instead.
   */
  get<T, D extends string = string>(
    driver: D extends KnownDriverName ? never : D,
    event: string,
  ): Promise<T>;
  /** Run a driver action and return its result. */
  execute<D extends DriverName, A extends DriverAction<D>>(
    driver: D,
    action: A,
    ...params: DriverActionArgs<D, A>
  ): Promise<DriverActionResult<D, A>>;
  /**
   * @deprecated Casts the result of a driver the SDK doesn't know. Generate
   * its types with `gosai-sdk gen-driver-types` instead.
   */
  execute<T, D extends string = string>(
    driver: D extends KnownDriverName ? never : D,
    action: string,
    data?: unknown,
  ): Promise<T>;
}

export interface StorageClient {
  /** Returns the stored value, or `undefined` when the key is missing. */
  get<T = unknown>(key: string): Promise<T | undefined>;
  /** Returns the stored value, or `fallback` when the key is missing. */
  get<T>(key: string, fallback: T): Promise<T>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
  list(): Promise<string[]>;
}

export interface SettingsClient {
  /**
   * The app's settings as one nested object: stored values merged over the
   * defaults declared in the manifest. Keys are the dotted field keys split
   * into objects, so `projection.mode` is `settings.projection.mode`.
   */
  get<T extends object = Record<string, unknown>>(): Promise<T>;
  /**
   * Stores values by dotted key, e.g. `{ 'projection.mode': 'reflection' }`.
   * Keys you don't pass keep their stored value, or keep following the
   * manifest default when nothing was stored.
   */
  set(values: Readonly<Record<string, unknown>>): Promise<void>;
}

export interface AssetsClient {
  /**
   * Absolute URL of a file in the app, relative to the app root (e.g.
   * `assets/logo.png`). The app's security policy only loads files from its
   * own origin, so there is no way to address another app's files.
   */
  url(path: string): string;
}

export interface AppLogger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

export interface ExperienceRouter {
  switchTo(slug: string): Promise<void>;
  stop(slug?: string): Promise<void>;
  current(): string | null;
  /** Called when any of the app's experiences changes state. */
  onStateChange(listener: (state: RunningExperience) => void): () => void;
}

export interface FrameInfo {
  /** `requestAnimationFrame` timestamp, comparable with `performance.now()`. */
  readonly timestamp: number;
  /**
   * Milliseconds since the previous frame, capped so a stall (a hidden
   * window, a long task) doesn't make animations jump.
   */
  readonly deltaMs: number;
  /** Frames rendered before this one. */
  readonly frameCount: number;
}

/**
 * An experience's lifecycle. The name, description and slug come from the
 * app's manifest, and are available as `rt.app.experience`.
 */
export interface ExperienceDefinition<TState = void> {
  /** Builds the experience's state. Runs once, before `start`. */
  init?(rt: ExperienceRuntimeContext): TState | Promise<TState>;
  /** Called when the experience becomes active. */
  start?(rt: ExperienceRuntimeContext, state: TState): void | Promise<void>;
  /** Called every animation frame. */
  render?(rt: ExperienceRuntimeContext, state: TState, frame: FrameInfo): void;
  /** Called when the experience stops. Release what the runtime doesn't track. */
  stop?(rt: ExperienceRuntimeContext, state: TState): void | Promise<void>;
}
