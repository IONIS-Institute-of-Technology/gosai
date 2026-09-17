/**
 * App hosting. Each app runs on its own origin, `http://<slug>.localhost:<port>`,
 * so apps don't share web storage, permissions or caches with each other or
 * with the dashboard. Browsers resolve `*.localhost` to the loopback address
 * without DNS, and treat it as a secure context.
 *
 * On an app origin the server serves a static host page at `/`, the app's
 * manifest at `/gosai.app.json`, and on every origin the SDK bundle at `/sdk/`.
 * The host page loads the SDK's app host script, which imports the
 * experience entry and runs it.
 */

import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { TokenScope } from '@gosai/shared/auth';
import { appSlugFromHostname, isConnectSource } from '@gosai/shared/app-origin';

export { isConnectSource };

/** The import map is constant so the CSP can allow it by hash instead of 'unsafe-inline'. */
export const HOST_PAGE_IMPORT_MAP = JSON.stringify({
  imports: { '@gosai/sdk': '/sdk/index.js', '@gosai/sdk/': '/sdk/' },
});

const IMPORT_MAP_HASH = createHash('sha256').update(HOST_PAGE_IMPORT_MAP).digest('base64');

export interface AppPolicyOptions {
  /** Port the server listens on; app origins are only trusted on it. */
  readonly port: number;
  /** Extra `connect-src` origins from the manifest's `network.connect`. */
  readonly connect?: readonly string[];
}

/**
 * Content Security Policy for everything served on an app origin: the host
 * page, the app's static files (which may start workers or frames) and the
 * SDK bundle.
 */
export function appContentSecurityPolicy(options: AppPolicyOptions): string {
  // Other app origins on this server, so an app can import a companion app's
  // module, as the calibration runner does with the target's calibration entry.
  const appOrigins = `http://*.localhost:${options.port}`;
  // Re-checked here so a manifest that skipped validation can't inject directives.
  const connect = (options.connect ?? []).filter(isConnectSource);
  return [
    "default-src 'self'",
    // 'wasm-unsafe-eval' only allows compiling WebAssembly, which in-browser ML libraries need.
    `script-src 'self' ${appOrigins} 'sha256-${IMPORT_MAP_HASH}' 'wasm-unsafe-eval'`,
    "style-src 'self'",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "font-src 'self' data:",
    // blob: and data: cover loaders that fetch embedded resources, e.g. GLTF
    // textures and ML model weights. Plain http and ws to other hosts would
    // reach local services, so apps list the ones they need in the manifest.
    ["connect-src 'self' blob: data: https: wss:", ...connect].join(' '),
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export const HOST_PAGE_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="dark" />
    <title>GOSAI</title>
    <script type="importmap">${HOST_PAGE_IMPORT_MAP}</script>
    <script type="module" src="/sdk/app-host.js"></script>
  </head>
  <body></body>
</html>
`;

/** The host page. The server adds the app's CSP to every app-origin response. */
export function hostPageResponse(): Response {
  return new Response(HOST_PAGE_HTML, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // The page URL carries the app token until the loader strips it.
      'referrer-policy': 'no-referrer',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

/** The app slug a `Host` header names, or `null`. */
export function appSlugFromHost(host: string | null | undefined): string | null {
  if (!host) return null;
  try {
    return appSlugFromHostname(new URL(`http://${host}`).hostname);
  } catch {
    return null;
  }
}

/** The app slug of an `http://<slug>.localhost[:port]` origin, or `null`. */
export function appSlugFromOrigin(origin: string | null | undefined): string | null {
  if (!origin) return null;
  try {
    const url = new URL(origin);
    return url.protocol === 'http:' ? appSlugFromHostname(url.hostname) : null;
  } catch {
    return null;
  }
}

/**
 * A page on an app origin may only use that app's token. Returns why the
 * request is refused, or `null` when it isn't sent from an app origin or
 * the token matches. The Origin header wins over Host, since a page may call
 * the server through another hostname.
 */
export function appOriginDenial(req: Request, scope: TokenScope): string | null {
  const slug =
    appSlugFromOrigin(req.headers.get('origin')) ?? appSlugFromHost(req.headers.get('host'));
  if (slug === null) return null;
  if (scope.kind === 'app' && scope.appSlug === slug) return null;
  const holder = scope.kind === 'app' ? `app ${scope.appSlug}` : 'the dashboard';
  return `the token for ${holder} can't be used from the ${slug} app origin`;
}

const SDK_FILE = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;

/**
 * Resolves `/sdk/<name>` to a bundle file. `name` may omit `.js`, because the
 * import map's `@gosai/sdk/` prefix turns `@gosai/sdk/host` into `/sdk/host`.
 */
export function resolveSdkFile(sdkDir: string, name: string): string | null {
  if (!SDK_FILE.test(name)) return null;
  const file = name.endsWith('.js') ? name : `${name}.js`;
  const path = join(sdkDir, file);
  try {
    return statSync(path).isFile() ? path : null;
  } catch {
    return null;
  }
}
