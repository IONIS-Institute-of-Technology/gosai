/// <reference types="node" />
/**
 * Access tokens for the GOSAI server.
 *
 * Desktop main generates a dashboard token at each launch and hands it to the
 * server and the dashboard window. App windows get an app token derived from
 * the dashboard token with an HMAC, so main can mint one per window without a
 * round trip and the server can verify it without storing anything.
 *
 * An app token names the app it belongs to plus any extra apps it may touch
 * (the calibration runner writes into its target app's storage, for example).
 *
 * Uses `node:crypto`, so only Node, Bun and Electron main import this module.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { assertSlug, isValidSlug } from './slug.js';

export type TokenScope =
  | { readonly kind: 'dashboard' }
  | {
      readonly kind: 'app';
      /** The app the window runs. */
      readonly appSlug: string;
      /** Every app whose storage, settings, events and drivers the token may use. */
      readonly slugs: readonly string[];
    };

const APP_PREFIX = 'app';
const MAC_CONTEXT = 'gosai-app-token-v1:';

export function generateDashboardToken(): string {
  return randomBytes(32).toString('base64url');
}

export function mintAppToken(
  dashboardToken: string,
  appSlug: string,
  extraSlugs: readonly string[] = [],
): string {
  const slugs = [...new Set([appSlug, ...extraSlugs])].map((slug) => assertSlug(slug, 'app slug'));
  const body = slugs.join('+');
  return `${APP_PREFIX}.${body}.${sign(dashboardToken, body)}`;
}

/** Returns the token's scope, or `null` when the token is missing or invalid. */
export function verifyToken(
  dashboardToken: string,
  token: string | null | undefined,
): TokenScope | null {
  if (!token || !dashboardToken) return null;
  if (safeEqual(token, dashboardToken)) return { kind: 'dashboard' };

  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== APP_PREFIX) return null;
  const [, body = '', mac = ''] = parts;
  if (!safeEqual(mac, sign(dashboardToken, body))) return null;

  const slugs = body.split('+');
  const [appSlug] = slugs;
  if (appSlug === undefined || !slugs.every(isValidSlug)) return null;
  return { kind: 'app', appSlug, slugs };
}

function sign(key: string, body: string): string {
  return createHmac('sha256', key)
    .update(MAC_CONTEXT + body)
    .digest('base64url');
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
