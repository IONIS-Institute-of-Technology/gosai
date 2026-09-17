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
