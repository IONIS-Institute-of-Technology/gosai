import { resolve } from 'node:path';
import { Hono } from 'hono';
import { PROTOCOL_VERSION, type ClientMessage } from '@gosai/shared/protocol';
import type { AppDeviceSettingsPatch } from '@gosai/shared';
import { ServerEvents } from '@gosai/shared/events';
import type { GosaiPaths } from './paths.js';
import { Logger } from './logger/index.js';
import { EventBus, WebSocketGateway, type ClientData } from './ipc/index.js';
import { AppSettingsStore, ConfigStore } from './config/index.js';
import { DriverManager, SYSTEM_BINDING } from './drivers/index.js';
import { applyAppDeviceSettings, applyCameraSettings } from './drivers/camera-config.js';
import { AppManager } from './apps/index.js';
import { AppStorage } from './apps/storage.js';
import { SystemMonitor } from './monitor/index.js';
import { existsSync, statSync } from 'node:fs';
import { join, normalize } from 'node:path';

const SERVER_VERSION = '0.1.0';

export interface ServerOptions {
  readonly host: string;
  readonly port: number;
  readonly paths: GosaiPaths;
  readonly pythonDir?: string;
  readonly builtinAppsDir?: string;
  readonly enablePython?: boolean;
}

export interface GosaiServer {
  stop(): Promise<void>;
  readonly logger: Logger;
  readonly bus: EventBus;
  readonly drivers: DriverManager;
  readonly apps: AppManager;
  readonly monitor: SystemMonitor;
  readonly config: ConfigStore;
  readonly appSettings: AppSettingsStore;
}

export async function createServer(options: ServerOptions): Promise<GosaiServer> {
  const logger = new Logger({ logsDir: options.paths.logs });
  const log = logger.child('server');

  const bus = new EventBus();

  logger.subscribe((entry) => bus.emit(ServerEvents.Log, entry, 'logger'));

  const config = new ConfigStore(options.paths.config, bus, logger.child('config'));
  const appSettings = new AppSettingsStore(options.paths.apps, bus, logger.child('app-config'));

  const pythonDir = resolvePythonDir(options.pythonDir);

  const drivers = new DriverManager({
    pythonDir,
    logger,
    bus,
    // Per-app device assignments take priority; the camera falls back to the
    // global default so single-app setups keep working without per-app config.
    // The global camera is layered underneath the per-app block so an app that
    // only pins a device (no resolution/fps) still inherits sensible defaults.
    getDriverConfig: (binding, driver) => {
      const app = binding === SYSTEM_BINDING ? undefined : appSettings.get(binding);
      if (driver === 'camera') return { ...config.get().camera, ...app?.camera };
      if (driver === 'microphone') return app?.microphone ? { ...app.microphone } : undefined;
      if (driver === 'speaker') return app?.speaker ? { ...app.speaker } : undefined;
      return undefined;
    },
  });

  if (options.enablePython !== false && pythonHasBridge(pythonDir)) {
    try {
      await drivers.start();
    } catch (err) {
      log.warn('failed to start python bridge', { err: String(err) });
    }
  } else {
    log.info('python bridge disabled or unavailable', { pythonDir });
  }

  const apps = new AppManager({
    paths: options.paths,
    logger,
    bus,
    drivers,
    builtinAppsDir: options.builtinAppsDir,
  });
  const storage = new AppStorage(options.paths);

  const monitor = new SystemMonitor({ bus, logger: logger.child('monitor') });
  monitor.start();

  const gateway = new WebSocketGateway(bus, logger.child('ipc'), {
    onClientDisconnect: (clientId) =>
      drivers
        .unsubscribeAll(clientId)
        .catch((err) => log.warn('driver cleanup failed', { clientId, err: String(err) })),
  });
  registerHandlers(gateway, { apps, drivers, config, appSettings, logger, bus });

  const app = new Hono();

  app.use('*', async (c, next) => {
    await next();
    c.header('Access-Control-Allow-Origin', '*');
    c.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    c.header('Access-Control-Allow-Headers', 'Content-Type');
    c.header('Access-Control-Max-Age', '86400');
  });
  app.options('*', (c) => c.body(null, 204));

  app.get('/healthz', (c) => c.json({ ok: true, version: SERVER_VERSION }));
  app.get('/v1/info', (c) =>
    c.json({
      protocolVersion: PROTOCOL_VERSION,
      serverVersion: SERVER_VERSION,
      paths: options.paths,
    }),
  );
  app.get('/v1/apps', (c) => c.json({ apps: apps.listApps() }));
  app.get('/v1/drivers', (c) => c.json({ drivers: drivers.listDrivers() }));
  app.get('/v1/experiences', (c) => c.json({ experiences: apps.listRunningExperiences() }));

  app.post('/v1/experiences/stop', async (c) => {
    let body: { appSlug?: string; experienceSlug?: string };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    if (!body.appSlug || !body.experienceSlug) {
      return c.json({ error: 'appSlug and experienceSlug are required' }, 400);
    }
    try {
      await apps.stopExperience(body.appSlug, body.experienceSlug);
      return c.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });
  app.get('/v1/config', (c) => c.json(config.get()));
  app.get('/v1/logs', (c) => c.json({ logs: logger.history() }));

  // Per-app storage endpoints used by the SDK StorageClient.
  app.get('/v1/apps/:slug/storage', (c) => {
    const slug = c.req.param('slug');
    if (!apps.getApp(slug)) return c.json({ error: 'app not found' }, 404);
    return c.json({ keys: storage.list(slug) });
  });
  app.get('/v1/apps/:slug/storage/:key', (c) => {
    const slug = c.req.param('slug');
    const key = c.req.param('key');
    if (!apps.getApp(slug)) return c.json({ error: 'app not found' }, 404);
    const value = storage.get(slug, key);
    if (value === undefined) return c.json({ error: 'not found' }, 404);
    return c.json(value);
  });
  app.post('/v1/apps/:slug/storage/:key', async (c) => {
    const slug = c.req.param('slug');
    const key = c.req.param('key');
    if (!apps.getApp(slug)) return c.json({ error: 'app not found' }, 404);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    storage.set(slug, key, body);
    return c.json({ ok: true });
  });
  app.delete('/v1/apps/:slug/storage/:key', (c) => {
    const slug = c.req.param('slug');
    const key = c.req.param('key');
    if (!apps.getApp(slug)) return c.json({ error: 'app not found' }, 404);
    const removed = storage.remove(slug, key);
    return c.json({ ok: removed });
  });

  // Static assets for installed apps so the app-host renderer can fetch them
  // directly. Path traversal is prevented by normalising and prefix-checking.
  app.get('/v1/apps/:slug/static/*', async (c) => {
    const slug = c.req.param('slug');
    const installed = apps.getApp(slug);
    if (!installed) return c.json({ error: 'app not found' }, 404);
    const relative = c.req.path.split(`/v1/apps/${slug}/static/`)[1] ?? '';
    const safe = normalize(relative).replace(/^\.\.[/\\]/, '');
    const filePath = join(installed.installPath, safe);
    if (!filePath.startsWith(installed.installPath)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      return c.json({ error: 'not found' }, 404);
    }
    const data = await Bun.file(filePath).arrayBuffer();
    const mime = guessMime(filePath);
    return new Response(data, {
      headers: { 'content-type': mime, 'cache-control': 'no-cache' },
    });
  });

  // Bundled SDK runtime served to apps via static script tag.
  app.get('/sdk-runtime.js', async (c) => {
    const sdkPath = resolve(import.meta.dir, '..', '..', 'sdk', 'dist', 'browser.js');
    if (existsSync(sdkPath)) {
      const data = await Bun.file(sdkPath).arrayBuffer();
      return new Response(data, {
        headers: {
          'content-type': 'application/javascript; charset=utf-8',
          'cache-control': 'no-cache',
        },
      });
    }
    return c.json({ error: 'SDK runtime bundle not built' }, 404);
  });

  let server: ReturnType<typeof Bun.serve<ClientData>>;
  try {
    server = Bun.serve<ClientData>({
      hostname: options.host,
      port: options.port,
      fetch(req, srv) {
        const url = new URL(req.url);
        if (url.pathname === '/ws') {
          const data: ClientData = { clientId: crypto.randomUUID() };
          if (srv.upgrade(req, { data })) {
            return undefined;
          }
          return new Response('Upgrade failed', { status: 426 });
        }
        return app.fetch(req);
      },
      websocket: {
        open(ws) {
          gateway.onOpen(ws);
        },
        close(ws) {
          gateway.onClose(ws);
        },
        async message(ws, msg) {
          await gateway.onMessage(ws, msg);
        },
      },
    });
  } catch (err) {
    const message = String((err as Error)?.message ?? err);
    if (message.includes('EADDRINUSE') || message.includes('Address already in use')) {
      log.error('port already in use', { port: options.port, host: options.host });
      throw new Error(
        `GOSAI cannot bind to ${options.host}:${options.port} - the port is already in use. ` +
          'Stop the other process or set GOSAI_PORT to a free port.',
      );
    }
    throw err;
  }

  log.info(`gosai server up on http://${options.host}:${options.port}`);

  return {
    logger,
    bus,
    drivers,
    apps,
    monitor,
    config,
    appSettings,
    async stop() {
      log.info('shutting down');
      monitor.stop();
      gateway.close();
      try {
        await apps.shutdown();
      } catch (err) {
        log.warn('apps shutdown error', { err: String(err) });
      }
      try {
        await drivers.stop();
      } catch (err) {
        log.warn('drivers shutdown error', { err: String(err) });
      }
      server.stop();
    },
  };
}

function registerHandlers(
  gateway: WebSocketGateway,
  ctx: {
    apps: AppManager;
    drivers: DriverManager;
    config: ConfigStore;
    appSettings: AppSettingsStore;
    logger: Logger;
    bus: EventBus;
  },
): void {
  const { apps, drivers, config, appSettings, logger, bus } = ctx;

  gateway.registerHandler('apps:list', () => ({ apps: apps.listApps() }));
  gateway.registerHandler('app:install', async (msg: ClientMessage) => {
    const payload = (msg as { payload: { source?: string } }).payload;
    if (!payload?.source) throw new Error('source is required');
    return await apps.installFromGit(payload.source);
  });
  gateway.registerHandler('app:uninstall', async (msg: ClientMessage) => {
    const payload = (msg as { payload: { slug?: string } }).payload;
    if (!payload?.slug) throw new Error('slug is required');
    await apps.uninstall(payload.slug);
    return { slug: payload.slug };
  });

  gateway.registerHandler('experiences:list', () => ({
    experiences: apps.listRunningExperiences(),
  }));
  gateway.registerHandler('experience:start', async (msg: ClientMessage) => {
    const payload = (msg as { payload: { appSlug?: string; experienceSlug?: string } }).payload;
    if (!payload?.appSlug || !payload.experienceSlug) {
      throw new Error('appSlug and experienceSlug are required');
    }
    return await apps.startExperience(payload.appSlug, payload.experienceSlug);
  });
  gateway.registerHandler('experience:stop', async (msg: ClientMessage) => {
    const payload = (msg as { payload: { appSlug?: string; experienceSlug?: string } }).payload;
    if (!payload?.appSlug || !payload.experienceSlug) {
      throw new Error('appSlug and experienceSlug are required');
    }
    await apps.stopExperience(payload.appSlug, payload.experienceSlug);
    return { ok: true };
  });

  gateway.registerHandler('drivers:list', () => ({ drivers: drivers.listDrivers() }));
  gateway.registerHandler('devices:list', async () => await drivers.listDevices());
  gateway.registerHandler('driver:get-data', async (msg: ClientMessage) => {
    const payload = (msg as { payload: { driver?: string; event?: string; binding?: string } })
      .payload;
    if (!payload?.driver || !payload.event) throw new Error('driver and event are required');
    return await drivers.getData(payload.binding ?? SYSTEM_BINDING, payload.driver, payload.event);
  });
  gateway.registerHandler('driver:execute', async (msg: ClientMessage) => {
    const payload = (
      msg as { payload: { driver?: string; action?: string; data?: unknown; binding?: string } }
    ).payload;
    if (!payload?.driver || !payload.action) throw new Error('driver and action are required');
    return await drivers.execute(
      payload.binding ?? SYSTEM_BINDING,
      payload.driver,
      payload.action,
      payload.data,
    );
  });
  gateway.registerHandler('driver:subscribe', async (msg: ClientMessage, ctx) => {
    const payload = (msg as { payload: { driver?: string; event?: string; binding?: string } })
      .payload;
    if (!payload?.driver || !payload.event) throw new Error('driver and event are required');
    await drivers.subscribe(
      payload.binding ?? SYSTEM_BINDING,
      payload.driver,
      payload.event,
      ctx.clientId,
    );
    return { ok: true };
  });
  gateway.registerHandler('driver:unsubscribe', async (msg: ClientMessage, ctx) => {
    const payload = (msg as { payload: { driver?: string; event?: string; binding?: string } })
      .payload;
    if (!payload?.driver || !payload.event) throw new Error('driver and event are required');
    await drivers.unsubscribe(
      payload.binding ?? SYSTEM_BINDING,
      payload.driver,
      payload.event,
      ctx.clientId,
    );
    return { ok: true };
  });

  gateway.registerHandler('logs:history', () => ({ logs: logger.history() }));
  gateway.registerHandler('config:get', () => config.get());
  gateway.registerHandler('config:set', async (msg: ClientMessage) => {
    const payload = (msg as { payload: Record<string, unknown> }).payload;
    const next = config.update(payload);
    await applyCameraSettings(drivers, 'system', next.camera, logger.child('camera'));
    return next;
  });

  gateway.registerHandler('app:config:get', (msg: ClientMessage) => {
    const payload = (msg as { payload: { appSlug?: string } }).payload;
    if (!payload?.appSlug) throw new Error('appSlug is required');
    return appSettings.get(payload.appSlug);
  });
  gateway.registerHandler('app:config:set', async (msg: ClientMessage) => {
    const payload = (msg as { payload: { appSlug?: string; settings?: AppDeviceSettingsPatch } })
      .payload;
    if (!payload?.appSlug) throw new Error('appSlug is required');
    const next = appSettings.update(payload.appSlug, payload.settings ?? {});
    await applyAppDeviceSettings(drivers, payload.appSlug, next, logger.child('app-config'));
    return next;
  });

  // App-scoped pub/sub used by multi-window experiences (e.g. calibration
  // running in projector + control windows). Emits `app:<slug>:<topic>` on
  // the bus; clients subscribed to that event name receive it.
  gateway.registerHandler('app:broadcast', (msg: ClientMessage) => {
    const payload = msg.payload as {
      appSlug?: string;
      topic?: string;
      data?: unknown;
    };
    if (!payload?.appSlug || !payload.topic) {
      throw new Error('appSlug and topic are required');
    }
    bus.emit(
      `app:${payload.appSlug}:${payload.topic}`,
      payload.data ?? null,
      `app:${payload.appSlug}`,
    );
    return { ok: true };
  });

  // App-level log forwarding. Apps using the SDK log via app:log; we re-emit
  // through the central logger so the dashboard shows them inline.
  gateway.registerHandler('app:log', (msg: ClientMessage) => {
    const payload = msg.payload as {
      source?: string;
      level?: 'debug' | 'info' | 'warn' | 'error';
      message?: string;
      data?: Record<string, unknown> | null;
    };
    if (!payload?.source || !payload.message) {
      return { ok: false };
    }
    const level = payload.level ?? 'info';
    logger.log(payload.source, level, payload.message, payload.data ?? undefined);
    return { ok: true };
  });
}

function guessMime(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.html')) return 'text/html; charset=utf-8';
  if (lower.endsWith('.js') || lower.endsWith('.mjs'))
    return 'application/javascript; charset=utf-8';
  if (lower.endsWith('.json')) return 'application/json; charset=utf-8';
  if (lower.endsWith('.css')) return 'text/css; charset=utf-8';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.ico')) return 'image/x-icon';
  if (lower.endsWith('.txt') || lower.endsWith('.md')) return 'text/plain; charset=utf-8';
  if (lower.endsWith('.wasm')) return 'application/wasm';
  return 'application/octet-stream';
}

function resolvePythonDir(override?: string): string {
  if (override) return resolve(override);
  const env = process.env.GOSAI_PYTHON_DIR;
  if (env) return resolve(env);
  return resolve(import.meta.dir, '..', '..', '..', 'python');
}

function pythonHasBridge(pythonDir: string): boolean {
  return existsSync(join(pythonDir, '.venv', 'bin', 'gosai-bridge'));
}
