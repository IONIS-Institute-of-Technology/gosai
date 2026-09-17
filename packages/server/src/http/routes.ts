/**
 * HTTP routes. Everything an app does at runtime goes over the WebSocket; HTTP
 * serves what a browser loads by URL (the app host page, the manifest, app
 * files, the SDK bundle) plus a health check and a token probe.
 */

import { Hono } from 'hono';
import { PROTOCOL_VERSION } from '@gosai/shared/protocol';
import { isValidSlug } from '@gosai/shared/slug';
import type { TokenScope } from '@gosai/shared/auth';
import type { RequestGuard } from '../access/request-guard.js';
import {
  appContentSecurityPolicy,
  appOriginDenial,
  appSlugFromHost,
  hostPageResponse,
  resolveSdkFile,
  SDK_BASE_PATH,
} from '../apps/app-host.js';
import type { AppManager } from '../apps/manager.js';
import { SDK_VERSION } from '../apps/sdk-version.js';
import { resolveStaticFile } from '../apps/static-files.js';
import { SERVER_VERSION } from '../version.js';

export interface HttpRoutesOptions {
  readonly apps: Pick<AppManager, 'getInstallPath' | 'getManifest'>;
  readonly guard: RequestGuard;
  readonly authenticate: (req: Request) => TokenScope | null;
  /** The bound port, read per request because port 0 resolves late. */
  readonly port: () => number;
  /** The built SDK served under `/sdk/<version>/`, when built. */
  readonly sdkDir?: string;
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
    // Every response on an app origin carries the app's policy, so a worker or
    // frame started from the app's files can't escape it.
    const hostSlug = appSlugFromHost(c.req.header('host'));
    if (hostSlug) {
      const connect = apps.getManifest(hostSlug)?.network?.connect;
      c.header(
        'content-security-policy',
        appContentSecurityPolicy({ port: options.port(), ...(connect ? { connect } : {}) }),
      );
    }
  });
  app.options('*', (c) => c.body(null, 204));

  // App hosting (apps/app-host.ts). The host page, the manifest and the SDK
  // bundle hold no secrets and load before the page has read its token.
  app.get('/', (c) => (appSlugFromHost(c.req.header('host')) ? hostPageResponse() : c.notFound()));
  app.get('/gosai.app.json', (c) => {
    const slug = appSlugFromHost(c.req.header('host'));
    if (!slug) return c.notFound();
    const manifest = apps.getManifest(slug);
    if (!manifest) return c.json({ error: `app ${slug} is not installed` }, 404);
    return c.json(manifest, 200, { 'cache-control': 'no-store' });
  });
  app.get('/sdk/:version/:file', (c) => {
    const version = c.req.param('version');
    if (version !== SDK_VERSION) {
      return c.json(
        { error: `this server provides @gosai/sdk ${SDK_VERSION}, not ${version}` },
        404,
      );
    }
    const file = options.sdkDir ? resolveSdkFile(options.sdkDir, c.req.param('file')) : null;
    if (!file) return c.json({ error: 'SDK file not found; run `bun run build:sdk`' }, 404);
    return new Response(Bun.file(file), {
      headers: {
        'content-type': 'text/javascript; charset=utf-8',
        // Revalidated: a development build changes without a version bump.
        'cache-control': 'no-cache',
        'x-content-type-options': 'nosniff',
      },
    });
  });
  // Unversioned URLs from before the SDK was versioned.
  app.get('/sdk/:file', (c) =>
    c.redirect(`${SDK_BASE_PATH}${encodeURIComponent(c.req.param('file'))}`, 308),
  );
  app.get('/sdk-runtime.js', (c) => c.redirect(`${SDK_BASE_PATH}index.js`, 308));

  // App files load through `import()` and `<img>`, which can't send a token.
  // Every other /v1 route needs one, and a page on an app origin may only use
  // that app's token.
  app.use('/v1/*', async (c, next) => {
    if (STATIC_PREFIX.test(c.req.path)) return next();
    const scope = options.authenticate(c.req.raw);
    if (!scope) return c.json({ error: 'unauthorized' }, 401);
    const denial = appOriginDenial(c.req.raw, scope);
    if (denial) return c.json({ error: denial }, 403);
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
    // An app origin only serves its own files, so one app's pages can't run
    // with another app's origin. Other apps' files load from their origins.
    const hostSlug = appSlugFromHost(c.req.header('host'));
    if (hostSlug !== null && hostSlug !== slug) return c.json({ error: 'not found' }, 404);
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

  return app;
}
