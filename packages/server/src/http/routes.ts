/**
 * HTTP routes. Everything an app does at runtime goes over the WebSocket; HTTP
 * only serves what a browser loads by URL (app files, the SDK bundle) plus a
 * health check and a token probe.
 */

import { Hono } from 'hono';
import { PROTOCOL_VERSION } from '@gosai/shared/protocol';
import { isValidSlug } from '@gosai/shared/slug';
import type { TokenScope } from '@gosai/shared/auth';
import type { RequestGuard } from '../access/request-guard.js';
import type { AppManager } from '../apps/manager.js';
import { resolveStaticFile } from '../apps/static-files.js';
import { SERVER_VERSION } from '../version.js';

export interface HttpRoutesOptions {
  readonly apps: Pick<AppManager, 'getInstallPath'>;
  readonly guard: RequestGuard;
  readonly authenticate: (req: Request) => TokenScope | null;
  /** The bundled SDK served at `/sdk-runtime.js`, when built. */
  readonly sdkRuntimePath?: string;
}

const STATIC_PREFIX = /^\/v1\/apps\/[^/]+\/static\//;

export function createHttpRoutes(options: HttpRoutesOptions): Hono {
  const { apps, guard } = options;
  const app = new Hono();

  app.use('*', async (c, next) => {
    await next();
    for (const [name, value] of Object.entries(guard.corsHeaders(c.req.raw))) {
      c.header(name, value);
    }
  });
  app.options('*', (c) => c.body(null, 204));

  // App files load through `import()` and `<img>`, which can't send a token.
  // Every other /v1 route needs one.
  app.use('/v1/*', async (c, next) => {
    if (STATIC_PREFIX.test(c.req.path)) return next();
    if (!options.authenticate(c.req.raw)) return c.json({ error: 'unauthorized' }, 401);
    return next();
  });

  app.get('/healthz', (c) => c.json({ ok: true, version: SERVER_VERSION }));

  /** Lets a client check its token before opening a WebSocket. */
  app.get('/v1/info', (c) =>
    c.json({ protocolVersion: PROTOCOL_VERSION, serverVersion: SERVER_VERSION }),
  );

  // resolveStaticFile keeps the resolved path inside the app.
  app.get('/v1/apps/:slug/static/*', (c) => {
    const slug = c.req.param('slug');
    if (!isValidSlug(slug)) return c.json({ error: 'invalid app slug' }, 400);
    const installPath = apps.getInstallPath(slug);
    if (!installPath) return c.json({ error: 'app not found' }, 404);
    const prefix = `/v1/apps/${slug}/static/`;
    const pathname = new URL(c.req.url).pathname;
    if (!pathname.startsWith(prefix)) return c.json({ error: 'not found' }, 404);
    let requestPath: string;
    try {
      requestPath = decodeURIComponent(pathname.slice(prefix.length));
    } catch {
      return c.json({ error: 'invalid path' }, 400);
    }
    const filePath = resolveStaticFile(installPath, requestPath);
    if (!filePath) return c.json({ error: 'not found' }, 404);
    return new Response(Bun.file(filePath), { headers: { 'cache-control': 'no-cache' } });
  });

  app.get('/sdk-runtime.js', async (c) => {
    const file = options.sdkRuntimePath ? Bun.file(options.sdkRuntimePath) : null;
    if (!file || !(await file.exists())) {
      return c.json({ error: 'SDK runtime bundle not built' }, 404);
    }
    return new Response(file, {
      headers: {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-cache',
      },
    });
  });

  return app;
}
