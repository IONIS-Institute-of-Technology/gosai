/**
 * Types for app code: the experience definition and the runtime context the
 * lifecycle hooks receive.
 */

import type { AppManifest, ExperienceDescriptor } from '@gosai/shared';

export type {
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
   * Launch parameters the window was opened with, such as `role` or `target`
   * for the calibration runner. The access token is never included.
   */
  readonly params: Readonly<Record<string, string>>;
  /** Underlying server connection, for commands the SDK doesn't wrap. */
  readonly server: ServerConnection;
  /** HTTP origin of the server for this app, e.g. `http://my-app.localhost:7777`. */
  readonly serverBaseUrl: string;
}

export interface ServerConnection {
  /** Token sent with HTTP calls such as storage. */
  readonly authToken?: string;
  connected(): boolean;
  request<T = unknown>(type: string, payload?: unknown): Promise<T>;
  on(event: string, listener: (payload: unknown) => void): () => void;
  onStatus(listener: (s: 'connecting' | 'connected' | 'disconnected') => void): () => void;
}

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
  unsubscribe(): void;
}

export interface DriverClient {
  /** Subscribe to a specific event from a driver. */
  on(driver: string, event: string, listener: (data: unknown) => void): DriverSubscription;
  /** Get the most recently emitted value for a driver event. */
  get<T = unknown>(driver: string, event: string): Promise<T>;
  /** Execute an action exposed by a driver and return its result. */
  execute<T = unknown>(driver: string, action: string, data?: unknown): Promise<T>;
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
   * `assets/logo.png`). Pass `appSlug` for a file of another installed app,
   * such as a companion app's module; it resolves against that app's origin.
   */
  url(path: string, appSlug?: string): string;
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
