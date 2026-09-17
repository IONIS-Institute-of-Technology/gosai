/**
 * Runtime entry point invoked from the app-host renderer. Provides everything
 * an experience needs to interact with the GOSAI server.
 */

import { ServerClient } from '@gosai/shared/client';
import { AppConfigClientImpl } from './app-config.js';
import { DriverClientImpl } from './driver-client.js';
import { StorageClientImpl } from './storage.js';
import { AppLoggerImpl } from './logger.js';
import { ExperienceRouterImpl } from './experience-router.js';
import { AppEventsClientImpl } from './events-client.js';
import type {
  AppContext,
  ExperienceDefinition,
  ExperienceRuntimeContext,
  FrameInfo,
  ServerConnection,
} from './types.js';

export interface RuntimeOptions {
  readonly appSlug: string;
  readonly experienceSlug: string;
  /**
   * App binding used for driver instances. Defaults to `appSlug`; calibration
   * uses this to run under the target app's camera settings while keeping
   * storage/events scoped to the calibration app.
   */
  readonly driverBinding?: string;
  /** HTTP base URL (e.g. http://127.0.0.1:7777) and WS URL are derived from this. */
  readonly serverBaseUrl: string;
  readonly wsUrl?: string;
  /** App token desktop main gave the window. */
  readonly authToken?: string;
}

export interface RuntimeHandle {
  readonly context: ExperienceRuntimeContext;
  readonly server: ServerConnection;
  stop(): Promise<void>;
}

/**
 * Loads, initialises, and starts an experience. Owns the render loop.
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

  await client.ready(5000);

  const drivers = new DriverClientImpl(client, options.driverBinding ?? options.appSlug);
  const storage = new StorageClientImpl(options.appSlug, client);
  const log = new AppLoggerImpl(`app:${options.appSlug}:${options.experienceSlug}`, client);
  // Failed driver subscriptions and throwing listeners end up in the app's log.
  client.onError((err, context) => log.error(`${context} failed`, { err: String(err) }));
  const router = new ExperienceRouterImpl(options.appSlug, client);
  const events = new AppEventsClientImpl(options.appSlug, client);
  router.setCurrent(options.experienceSlug);

  const app: AppContext = {
    appSlug: options.appSlug,
    experienceSlug: options.experienceSlug,
    server: client,
    serverBaseUrl: options.serverBaseUrl,
  };
  const ctx: ExperienceRuntimeContext = {
    app,
    drivers,
    storage,
    log,
    router,
    events,
    appConfig: new AppConfigClientImpl(options.appSlug, client),
  };

  let state: TState = undefined as unknown as TState;
  if (definition.lifecycle.init) {
    state = await Promise.resolve(definition.lifecycle.init());
  }
  await Promise.resolve(definition.lifecycle.start(ctx, state));

  let stopped = false;
  let rafId: number | null = null;
  let frameCount = 0;
  let lastFrameTime = performance.now();

  if (definition.lifecycle.render) {
    const renderFn = definition.lifecycle.render;
    const loop = (timestamp: number): void => {
      if (stopped) return;
      const deltaMs = timestamp - lastFrameTime;
      lastFrameTime = timestamp;
      const frame: FrameInfo = { timestamp, deltaMs, frameCount };
      try {
        renderFn(ctx, state, frame);
      } catch (err) {
        log.error('render failed', { err: String(err) });
      }
      frameCount += 1;
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);
  }

  return {
    context: ctx,
    server: client,
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      if (rafId !== null) cancelAnimationFrame(rafId);
      try {
        if (definition.lifecycle.stop) {
          await Promise.resolve(definition.lifecycle.stop(ctx, state));
        }
      } finally {
        client.close();
      }
    },
  };
}

function defaultWsUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/ws';
  return url.toString();
}
