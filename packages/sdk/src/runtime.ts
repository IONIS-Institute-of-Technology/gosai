/**
 * Runs one experience: builds the runtime context, calls the lifecycle hooks,
 * drives the render loop and releases everything the context handed out when
 * the experience stops.
 */

import type { AppDeviceSettings, AppManifest } from '@gosai/shared';
import { createAssetsClient } from './assets.js';
import { forwardCspViolations } from './csp-violations.js';
import { ServerClient } from '@gosai/shared/client';
import { AppConfigClientImpl } from './app-config.js';
import { DriverClientImpl } from './driver-client.js';
import { AppEventsClientImpl } from './events-client.js';
import { ExperienceRouterImpl } from './experience-router.js';
import { AppLoggerImpl } from './logger.js';
import { createSettingsClient, serverSettingsBackend, type SettingsBackend } from './settings.js';
import { StorageClientImpl } from './storage.js';
import type {
  AppConfigClient,
  AppContext,
  AppEventsClient,
  AppEventsSubscription,
  DriverClient,
  DriverSubscription,
  ExperienceDefinition,
  ExperienceRuntimeContext,
  ServerConnection,
} from './types.js';

export interface RuntimeOptions {
  readonly appSlug: string;
  readonly experienceSlug: string;
  /** The app's manifest. Identity, settings defaults and the experience entry come from it. */
  readonly manifest: AppManifest;
  /**
   * App binding used for driver instances. Defaults to `appSlug`; calibration
   * uses this to run under the target app's camera settings while keeping
   * storage and events scoped to the calibration app.
   */
  readonly driverBinding?: string;
  /** HTTP origin of the server, e.g. `http://my-app.localhost:7777`. */
  readonly serverBaseUrl: string;
  /** WebSocket URL. Derived from `serverBaseUrl` when omitted. */
  readonly wsUrl?: string;
  /** App token desktop main gave the window. */
  readonly authToken?: string;
  /** Launch parameters exposed as `rt.app.params`. */
  readonly params?: Readonly<Record<string, string>>;
  /** Aborting cancels a start in progress, or stops the running experience. */
  readonly signal?: AbortSignal;
  /** Upper bound for `frame.deltaMs`. Defaults to 100. */
  readonly maxDeltaMs?: number;
  /** Consecutive failing frames after which the runtime stops the experience. Defaults to 60. */
  readonly maxRenderFailures?: number;
  /** How long to wait for the server connection. Defaults to 5000 ms. */
  readonly connectTimeoutMs?: number;
  /** Called when the runtime stops the experience on its own, after repeated render failures. */
  readonly onFatalError?: (error: unknown) => void;
}

export interface RuntimeHandle {
  readonly context: ExperienceRuntimeContext;
  readonly server: ServerConnection;
  /** Stops the experience. Safe to call more than once. */
  stop(): Promise<void>;
}

/** Schedules animation frames. Swappable so the runtime can be tested without a browser. */
export interface FrameScheduler {
  request(callback: (timestamp: number) => void): number;
  cancel(handle: number): void;
  now(): number;
}

/** What the runtime needs besides its options. `runExperience` builds the browser version. */
export interface RuntimeEnvironment {
  readonly server: ServerConnection & { close(): void };
  readonly frames: FrameScheduler;
  readonly createAudioContext?: () => AudioContext;
  /** Replaces the settings backed by the server's `app:settings:*` commands. */
  readonly settings?: SettingsBackend;
  /** Where `securitypolicyviolation` events fire, normally `document`. They are logged. */
  readonly violations?: EventTarget;
}

export const DEFAULT_MAX_DELTA_MS = 100;
export const DEFAULT_MAX_RENDER_FAILURES = 60;
const DEFAULT_CONNECT_TIMEOUT_MS = 5000;
/** Distinct render error messages logged before the runtime goes quiet. */
const MAX_LOGGED_RENDER_ERRORS = 5;

/**
 * Connects to the server, then initialises, starts and renders the
 * experience. Rejects, with the connection closed, when connecting or a
 * lifecycle hook fails.
 */
export async function runExperience<TState>(
  definition: ExperienceDefinition<TState>,
  options: RuntimeOptions,
): Promise<RuntimeHandle> {
  const client = new ServerClient({
    url: options.wsUrl ?? defaultWsUrl(options.serverBaseUrl),
    ...(options.authToken ? { token: options.authToken } : {}),
  });
  client.connect();
  try {
    await waitForConnection(
      client,
      options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      options.signal,
    );
  } catch (err) {
    client.close();
    throw err;
  }
  return startRuntime(definition, options, {
    server: client,
    frames: browserFrames(),
    createAudioContext: () => new AudioContext(),
    violations: document,
  });
}

/** Runs an experience over an already connected server. */
export async function startRuntime<TState>(
  definition: ExperienceDefinition<TState>,
  options: RuntimeOptions,
  env: RuntimeEnvironment,
): Promise<RuntimeHandle> {
  const { server, frames } = env;
  const controller = new AbortController();
  const experience = options.manifest.experiences.find((e) => e.slug === options.experienceSlug);
  if (!experience) {
    server.close();
    throw new Error(`${options.appSlug} has no experience "${options.experienceSlug}"`);
  }

  const log = new AppLoggerImpl(`app:${options.appSlug}:${options.experienceSlug}`, server);
  // Failed driver subscriptions and throwing event listeners end up in the app's log.
  const offErrors = server.onError((err, context) =>
    log.error(`${context} failed`, describeError(err)),
  );
  const drivers = new TrackedDriverClient(
    new DriverClientImpl(server, options.driverBinding ?? options.appSlug),
  );
  const events = new TrackedEventsClient(new AppEventsClientImpl(options.appSlug, server));
  const storage = new StorageClientImpl(options.appSlug, server);
  const appConfig = new TrackedAppConfigClient(new AppConfigClientImpl(options.appSlug, server));
  const router = new ExperienceRouterImpl(options.appSlug, server);
  router.setCurrent(options.experienceSlug);
  const audio = new RuntimeAudio(env.createAudioContext, controller.signal);
  if (env.violations) forwardCspViolations(env.violations, log, controller.signal);

  const app: AppContext = {
    appSlug: options.appSlug,
    experienceSlug: options.experienceSlug,
    manifest: options.manifest,
    experience,
    params: Object.freeze({ ...options.params }),
    server,
    serverBaseUrl: options.serverBaseUrl,
  };
  const ctx: ExperienceRuntimeContext = {
    app,
    drivers,
    storage,
    settings: createSettingsClient(env.settings ?? serverSettingsBackend(options.appSlug, server)),
    assets: createAssetsClient(options.serverBaseUrl, options.appSlug),
    log,
    router,
    events,
    appConfig,
    signal: controller.signal,
    get audio(): AudioContext {
      return audio.get();
    },
    async ping(): Promise<number> {
      const sent = frames.now();
      await server.request('system:ping');
      return frames.now() - sent;
    },
  };

  let state: TState | undefined;
  let initialized = false;
  let stopping: Promise<void> | null = null;
  let frameHandle: number | null = null;

  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      if (frameHandle !== null) frames.cancel(frameHandle);
      frameHandle = null;
      // Release what the runtime tracks first, so no listener fires into a
      // stopping experience. The connection stays open for the stop hook.
      controller.abort();
      drivers.release();
      events.release();
      appConfig.release();
      try {
        if (initialized) await definition.stop?.(ctx, state as TState);
      } catch (err) {
        log.error('stop failed', describeError(err));
      } finally {
        await audio.close();
        offErrors();
        server.close();
      }
    })();
    return stopping;
  };

  // Hooks can't be interrupted, but rt.signal aborts right away so a running
  // hook can bail out; the cancellation is noticed between hooks.
  const cancelled = (): boolean => options.signal?.aborted === true;
  const onCancel = (): void => controller.abort();
  options.signal?.addEventListener('abort', onCancel, { once: true });
  try {
    if (cancelled()) throw abortError();
    state = await definition.init?.(ctx);
    initialized = true;
    if (cancelled()) throw abortError();
    await definition.start?.(ctx, state as TState);
    if (cancelled()) throw abortError();
  } catch (err) {
    if (!cancelled()) log.error('start failed', describeError(err));
    await stop();
    throw err;
  } finally {
    options.signal?.removeEventListener('abort', onCancel);
  }
  options.signal?.addEventListener('abort', () => void stop(), { once: true });

  audio.resume();

  const render = definition.render;
  if (render) {
    const maxDeltaMs = options.maxDeltaMs ?? DEFAULT_MAX_DELTA_MS;
    const maxFailures = options.maxRenderFailures ?? DEFAULT_MAX_RENDER_FAILURES;
    const loggedErrors = new Set<string>();
    let failures = 0;
    let frameCount = 0;
    let last = frames.now();

    const loop = (timestamp: number): void => {
      if (stopping) return;
      const deltaMs = Math.min(Math.max(timestamp - last, 0), maxDeltaMs);
      last = timestamp;
      try {
        render(ctx, state as TState, { timestamp, deltaMs, frameCount });
        failures = 0;
      } catch (err) {
        failures += 1;
        const message = describeError(err).message;
        if (loggedErrors.size < MAX_LOGGED_RENDER_ERRORS && !loggedErrors.has(message)) {
          loggedErrors.add(message);
          log.error('render failed', describeError(err));
        }
        if (failures >= maxFailures) {
          log.error(`stopping after ${failures} consecutive render failures`, { message });
          void stop();
          options.onFatalError?.(err);
          return;
        }
      }
      frameCount += 1;
      frameHandle = frames.request(loop);
    };
    frameHandle = frames.request(loop);
  }

  return { context: ctx, server, stop };
}

/** Driver client that remembers open subscriptions so the runtime can remove them. */
class TrackedDriverClient implements DriverClient {
  private readonly open = new Set<DriverSubscription>();
  private released = false;

  constructor(private readonly inner: DriverClient) {}

  on(driver: string, event: string, listener: (data: unknown) => void): DriverSubscription {
    if (this.released) return { ready: Promise.resolve(), unsubscribe: () => undefined };
    const inner = this.inner.on(driver, event, listener);
    const subscription: DriverSubscription = {
      ready: inner.ready,
      unsubscribe: () => {
        if (this.open.delete(subscription)) inner.unsubscribe();
      },
    };
    this.open.add(subscription);
    return subscription;
  }

  get<T = unknown>(driver: string, event: string): Promise<T> {
    return this.inner.get<T>(driver, event);
  }

  execute<T = unknown>(driver: string, action: string, data?: unknown): Promise<T> {
    return this.inner.execute<T>(driver, action, data);
  }

  release(): void {
    this.released = true;
    for (const subscription of this.open) subscription.unsubscribe();
  }
}

/** Listens for device assignment changes only while the experience runs. */
class TrackedAppConfigClient implements AppConfigClient {
  private readonly open = new Set<() => void>();
  private released = false;

  constructor(private readonly inner: AppConfigClient) {}

  get(): Promise<AppDeviceSettings> {
    return this.inner.get();
  }

  onChange(listener: (settings: AppDeviceSettings) => void): () => void {
    if (this.released) return () => undefined;
    const off = this.inner.onChange(listener);
    const unsubscribe = (): void => {
      if (this.open.delete(unsubscribe)) off();
    };
    this.open.add(unsubscribe);
    return unsubscribe;
  }

  release(): void {
    this.released = true;
    for (const unsubscribe of this.open) unsubscribe();
  }
}

/** App events client that remembers open subscriptions so the runtime can remove them. */
class TrackedEventsClient implements AppEventsClient {
  private readonly open = new Set<AppEventsSubscription>();
  private released = false;

  constructor(private readonly inner: AppEventsClient) {}

  emit(topic: string, data?: unknown): Promise<void> {
    return this.inner.emit(topic, data);
  }

  on(topic: string, listener: (data: unknown) => void): AppEventsSubscription {
    if (this.released) return { unsubscribe: () => undefined };
    const inner = this.inner.on(topic, listener);
    const subscription: AppEventsSubscription = {
      unsubscribe: () => {
        if (this.open.delete(subscription)) inner.unsubscribe();
      },
    };
    this.open.add(subscription);
    return subscription;
  }

  release(): void {
    this.released = true;
    for (const subscription of this.open) subscription.unsubscribe();
  }
}

/**
 * The runtime's AudioContext. Created on first use. Browsers may keep a new
 * context suspended until a user gesture, so it is resumed when the
 * experience starts and again on the first pointer or key press.
 */
class RuntimeAudio {
  private context: AudioContext | null = null;
  private started = false;
  private closed = false;

  constructor(
    private readonly create: (() => AudioContext) | undefined,
    private readonly signal: AbortSignal,
  ) {}

  get(): AudioContext {
    if (this.closed) throw new Error('the experience has stopped');
    if (!this.context) {
      if (!this.create) throw new Error('audio is not available in this runtime');
      this.context = this.create();
      if (this.started) this.resume();
    }
    return this.context;
  }

  resume(): void {
    this.started = true;
    const context = this.context;
    if (!context || context.state !== 'suspended') return;
    context.resume().catch(() => undefined);
    if (typeof window === 'undefined') return;
    const retry = (): void => {
      if (context.state === 'suspended') context.resume().catch(() => undefined);
    };
    for (const type of ['pointerdown', 'keydown'] as const) {
      window.addEventListener(type, retry, { once: true, signal: this.signal });
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    const context = this.context;
    this.context = null;
    if (context && context.state !== 'closed') await context.close().catch(() => undefined);
  }
}

function browserFrames(): FrameScheduler {
  return {
    request: (callback) => requestAnimationFrame(callback),
    cancel: (handle) => cancelAnimationFrame(handle),
    now: () => performance.now(),
  };
}

function defaultWsUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/ws';
  return url.toString();
}

async function waitForConnection(
  client: ServerClient,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (client.connected()) return;
  let offStatus = (): void => undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort = (): void => undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError());
        return;
      }
      offStatus = client.onStatus((status) => {
        if (status === 'connected') resolve();
      });
      timer = setTimeout(
        () => reject(new Error('Timed out connecting to GOSAI server')),
        timeoutMs,
      );
      onAbort = () => reject(abortError());
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  } finally {
    offStatus();
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

function abortError(): Error {
  return new DOMException('The experience was stopped while starting', 'AbortError');
}

function describeError(err: unknown): { message: string; stack?: string } {
  if (err instanceof Error) {
    return err.stack ? { message: err.message, stack: err.stack } : { message: err.message };
  }
  return { message: String(err) };
}
