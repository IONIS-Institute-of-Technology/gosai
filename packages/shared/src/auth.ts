/// <reference types="node" />
/**
 * Access tokens for the GOSAI server.
 *
 * Desktop main generates a dashboard token at each launch and hands it to the
 * server and the dashboard window. App windows get an app token derived from
 * the dashboard token with an HMAC, so main can mint one per window without a
 * round trip and the server can verify it without storing anything.
 *
 * An app token names the app it belongs to. A window opened for another app
 * also carries the driver binding it uses and the app it works for: the
 * calibration runner uses its target app's camera and saves that app's
 * calibration profile, but gets no other access to the target.
 *
 * Uses `node:crypto`, so only Node, Bun and Electron main import this module.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { assertSlug, isReservedSlug, isValidSlug } from './slug.js';

export type TokenScope =
  | { readonly kind: 'dashboard' }
  | {
      readonly kind: 'app';
      /** The app the window runs. Its storage, settings, events and drivers are the token's. */
      readonly appSlug: string;
      /** Another app's driver binding the window may use, such as a calibration target's camera. */
      readonly driverBinding: string | null;
      /**
       * The app the window was launched for. Commands with a `target`
       * capability reach it when the token's app holds that capability.
       */
      readonly target: string | null;
    };

/** What an app token grants besides its own app. */
export interface AppTokenClaims {
  readonly driverBinding?: string | undefined;
  readonly target?: string | undefined;
}

const APP_PREFIX = 'app';
const MAC_CONTEXT = 'gosai-app-token-v2:';

export function generateDashboardToken(): string {
  return randomBytes(32).toString('base64url');
}

/** `app.<appSlug>.<driverBinding>.<target>.<mac>`, with empty fields for missing claims. */
export function mintAppToken(
  dashboardToken: string,
  appSlug: string,
  claims: AppTokenClaims = {},
): string {
  const fields = [appSlug, claims.driverBinding, claims.target].map((slug, index) => {
    if (slug === undefined) {
      if (index === 0) throw new Error('app slug is missing');
      return '';
    }
    if (isReservedSlug(slug)) throw new Error(`${slug} is reserved and can't be an app slug`);
    return assertSlug(slug, 'app slug');
  });
  const body = fields.join('.');
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
  if (parts.length !== 5 || parts[0] !== APP_PREFIX) return null;
  const [, appSlug = '', driverBinding = '', target = '', mac = ''] = parts;
  if (!safeEqual(mac, sign(dashboardToken, [appSlug, driverBinding, target].join('.')))) {
    return null;
  }
  const optional = (slug: string): string | null | undefined =>
    slug === '' ? null : isAppSlug(slug) ? slug : undefined;
  const binding = optional(driverBinding);
  const launchedFor = optional(target);
  if (!isAppSlug(appSlug) || binding === undefined || launchedFor === undefined) return null;
  return { kind: 'app', appSlug, driverBinding: binding, target: launchedFor };
}

function isAppSlug(slug: string): boolean {
  return isValidSlug(slug) && !isReservedSlug(slug);
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
