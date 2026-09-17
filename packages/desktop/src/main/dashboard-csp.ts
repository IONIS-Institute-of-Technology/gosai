/**
 * The dashboard's Content-Security-Policy. Main sets it as a response header
 * because the server's port is only known at runtime. No Electron import, so
 * tests can check it.
 */

export interface DashboardPolicyOptions {
  /** The GOSAI server the dashboard connects to and loads app icons from. */
  readonly server: { readonly host: string; readonly port: number };
  /**
   * The Vite dev server under `electron-vite dev`. Its client needs inline
   * scripts and styles and a WebSocket for hot reload.
   */
  readonly devServerUrl?: string;
}

export function dashboardContentSecurityPolicy(options: DashboardPolicyOptions): string {
  const host = formatHost(options.server.host);
  const http = `http://${host}:${options.server.port}`;
  const ws = `ws://${host}:${options.server.port}`;
  const dev = options.devServerUrl ? new URL(options.devServerUrl) : null;
  const devOrigins = dev ? [dev.origin, `ws://${dev.host}`] : [];
  const inline = dev ? ["'unsafe-inline'"] : [];
  const directives: Record<string, readonly string[]> = {
    'default-src': ["'none'"],
    'script-src': ["'self'", ...inline],
    'style-src': ["'self'", ...inline],
    'img-src': ["'self'", 'data:', http],
    'font-src': ["'self'"],
    'connect-src': [ws, ...devOrigins],
    'base-uri': ["'none'"],
    'form-action': ["'none'"],
    'frame-ancestors': ["'none'"],
  };
  return Object.entries(directives)
    .map(([name, sources]) => `${name} ${sources.join(' ')}`)
    .join('; ');
}

/** IPv6 addresses go in brackets in a URL. */
function formatHost(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}
