/**
 * Host and Origin allowlist for HTTP requests and the `/ws` upgrade.
 *
 * The Host check stops DNS rebinding: a page on evil.example that resolves to
 * 127.0.0.1 still sends `Host: evil.example`. The Origin check stops other web
 * pages from reading responses. Requests without an Origin header (Electron
 * main, scripts, `<img>` loads) pass the Origin check.
 *
 * App origins (`http://<slug>.localhost:<port>`, see apps/app-host.ts) count
 * as loopback for both checks.
 */

import { appSlugFromHostname } from '@gosai/shared/app-origin';

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);
const WILDCARD_BIND_HOSTS = new Set(['0.0.0.0', '::', '[::]']);

export interface RequestGuardOptions {
  /** Hostname the server binds to. */
  readonly bindHost: string;
  /** Port the server listens on. Read on every request because port 0 resolves late. */
  readonly port: () => number;
  /** Extra hostnames clients may use, e.g. a LAN address when binding to 0.0.0.0. */
  readonly allowedHosts?: readonly string[];
  /**
   * Extra origins, compared exactly. Desktop main adds `file://` and `null`
   * for the dashboard window. Loopback http origins on any port are always allowed.
   */
  readonly allowedOrigins?: readonly string[];
}

export class RequestGuard {
  private readonly hostnames: Set<string>;
  private readonly origins: Set<string>;

  constructor(private readonly options: RequestGuardOptions) {
    this.hostnames = new Set(LOOPBACK_HOSTNAMES);
    if (!WILDCARD_BIND_HOSTS.has(options.bindHost)) {
      this.hostnames.add(normalizeHostname(options.bindHost));
    }
    for (const host of options.allowedHosts ?? []) this.hostnames.add(normalizeHostname(host));
    this.origins = new Set(options.allowedOrigins ?? []);
  }

  /** Returns a 403 response when Host or Origin isn't allowed, otherwise `null`. */
  reject(req: Request): Response | null {
    if (!this.hostAllowed(req.headers.get('host'))) {
      return new Response('Host not allowed', { status: 403 });
    }
    const origin = req.headers.get('origin');
    if (origin !== null && !this.originAllowed(origin)) {
      return new Response('Origin not allowed', { status: 403 });
    }
    return null;
  }

  hostAllowed(host: string | null): boolean {
    if (!host) return false;
    let url: URL;
    try {
      url = new URL(`http://${host}`);
    } catch {
      return false;
    }
    if (url.username || url.password || url.pathname !== '/') return false;
    const port = url.port === '' ? 80 : Number(url.port);
    if (port !== this.options.port()) return false;
    return this.hostnames.has(url.hostname) || appSlugFromHostname(url.hostname) !== null;
  }

  originAllowed(origin: string): boolean {
    if (this.origins.has(origin)) return true;
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      return false;
    }
    if (url.protocol !== 'http:') return false;
    if (LOOPBACK_HOSTNAMES.has(url.hostname)) return true;
    // App origins only exist on this server, so another port is someone else.
    const port = url.port === '' ? 80 : Number(url.port);
    return appSlugFromHostname(url.hostname) !== null && port === this.options.port();
  }

  /** CORS headers for an allowed request. Never a wildcard. */
  corsHeaders(req: Request): Record<string, string> {
    const origin = req.headers.get('origin');
    if (origin === null || !this.originAllowed(origin)) return {};
    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Max-Age': '600',
      Vary: 'Origin',
    };
  }
}

/** Reads `Authorization: Bearer <token>`. */
export function readBearerToken(req: Request): string | null {
  const header = req.headers.get('authorization');
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match?.[1] ?? null;
}

function normalizeHostname(host: string): string {
  const trimmed = host.trim().toLowerCase();
  return trimmed.includes(':') && !trimmed.startsWith('[') ? `[${trimmed}]` : trimmed;
}
