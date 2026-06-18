/**
 * Types shared between SDK and apps.
 */

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
  DriverState,
  LogEntry,
  LogLevel,
  GlobalConfig,
  PerformanceSample,
  SystemStats,
  DisplayInfo,
  ExperienceState,
  AppState,
} from '@gosai/shared';

export { PROTOCOL_VERSION } from '@gosai/shared/protocol';
export { ServerEvents, ClientCommands } from '@gosai/shared/events';

export interface AppContext {
  readonly appSlug: string;
  readonly experienceSlug: string;
  readonly server: ServerConnection;
  readonly serverBaseUrl: string;
}

export interface ServerConnection {
  connected(): boolean;
  request<T = unknown>(type: string, payload?: unknown): Promise<T>;
  on(event: string, listener: (payload: unknown) => void): () => void;
  onStatus(listener: (s: 'connecting' | 'connected' | 'disconnected') => void): () => void;
}

export interface ExperienceRuntimeContext {
  readonly app: AppContext;
  readonly drivers: DriverClient;
  readonly storage: StorageClient;
  readonly log: AppLogger;
  readonly router: ExperienceRouter;
  /**
   * App-scoped pub/sub. Useful when an experience runs in multiple windows
   * (e.g. projector + control window) and they need to coordinate state.
   */
  readonly events: AppEventsClient;
}

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
  /** Get the most recently-emitted value for a driver event. */
  get(driver: string, event: string): Promise<unknown>;
  /** Execute an action exposed by a driver. */
  execute(driver: string, action: string, data?: unknown): Promise<unknown>;
}

export interface StorageClient {
  get<T = unknown>(key: string, fallback?: T): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
  list(): Promise<string[]>;
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

export type ExperienceLifecycle<TState = void> = {
  /** Called once before `start`. Synchronous-only setup. */
  init?: () => TState | Promise<TState>;
  /** Called when the experience becomes active. */
  start: (ctx: ExperienceRuntimeContext, state: TState) => void | Promise<void>;
  /** Called every animation frame. Return early if you do not need a render loop. */
  render?: (ctx: ExperienceRuntimeContext, state: TState, frame: FrameInfo) => void;
  /** Called when the experience is being stopped. Release resources here. */
  stop?: (ctx: ExperienceRuntimeContext, state: TState) => void | Promise<void>;
};

export interface FrameInfo {
  readonly timestamp: number;
  readonly deltaMs: number;
  readonly frameCount: number;
}

export interface ExperienceDefinition<TState = void> {
  readonly slug: string;
  readonly name: string;
  readonly description?: string;
  readonly lifecycle: ExperienceLifecycle<TState>;
}
