/**
 * Each app runs on its own origin, `http://<slug>.localhost:<port>`. Browsers
 * resolve `*.localhost` to the loopback address without DNS and treat it as
 * a secure context, so apps get separate web storage and permissions without
 * a custom protocol.
 */

import { isValidSlug } from './slug.js';

const APP_HOSTNAME_SUFFIX = '.localhost';

/** Hostname of an app's origin. */
export function appHostname(slug: string): string {
  return `${slug}${APP_HOSTNAME_SUFFIX}`;
}

/** The app slug of a hostname like `my-app.localhost`, or `null`. */
export function appSlugFromHostname(hostname: string): string | null {
  const lower = hostname.toLowerCase();
  if (!lower.endsWith(APP_HOSTNAME_SUFFIX)) return null;
  const slug = lower.slice(0, -APP_HOSTNAME_SUFFIX.length);
  return isValidSlug(slug) ? slug : null;
}

const CONNECT_SOURCE =
  /^(?:https?|wss?):\/\/(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*|\[[0-9A-Fa-f:.]+\])(?::(\d{1,5}))?$/;

/**
 * Whether `value` is a plain `scheme://host[:port]` origin with an http,
 * https, ws or wss scheme: no path, query, wildcard, quote or whitespace.
 * Manifests list these in `network.connect`; the app CSP appends them.
 */
export function isConnectSource(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = CONNECT_SOURCE.exec(value);
  if (!match) return false;
  return match[1] === undefined || Number(match[1]) <= 65535;
}
