/**
 * What an app token may do. The dashboard token may do everything.
 *
 * This is a hardcoded list on purpose: PR 7 replaces it with capabilities that
 * each command declares.
 */

import type { TokenScope } from '@gosai/shared/auth';

/** Commands that change the whole installation. */
const DASHBOARD_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  'app:install',
  'app:uninstall',
  'config:set',
]);

interface AppField {
  readonly field: string;
  readonly optional: boolean;
}

const required = (field: string): AppField => ({ field, optional: false });

/**
 * Payload fields that name the apps whose resources a command touches. A
 * missing driver `binding` means the `system` binding, which apps can't use.
 */
const APP_SCOPED_FIELDS: Readonly<Record<string, readonly AppField[]>> = {
  'app:config:get': [required('appSlug')],
  'app:config:set': [required('appSlug')],
  'app:broadcast': [required('appSlug')],
  'driver:get-data': [required('binding')],
  'driver:execute': [required('binding')],
  'driver:subscribe': [required('binding')],
  'driver:unsubscribe': [required('binding')],
  'experience:start': [required('appSlug'), { field: 'driverBinding', optional: true }],
  'experience:stop': [required('appSlug')],
};

const DRIVER_EVENT_PREFIX = 'driver:event:';
const APP_EVENT = /^app:([^:]+):/;

export function canAccessApp(scope: TokenScope, slug: string): boolean {
  return scope.kind === 'dashboard' || scope.slugs.includes(slug);
}

/** Returns why `scope` may not run `command`, or `null` when it may. */
export function commandDenial(scope: TokenScope, command: string, payload: unknown): string | null {
  if (scope.kind === 'dashboard') return null;
  if (DASHBOARD_ONLY_COMMANDS.has(command)) return `${command} requires the dashboard token`;

  const values = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
  for (const { field, optional } of APP_SCOPED_FIELDS[command] ?? []) {
    const value = values[field];
    if (value === undefined && optional) continue;
    if (typeof value === 'string' && canAccessApp(scope, value)) continue;
    return `${command} with ${field}=${JSON.stringify(value ?? null)} is outside the token's apps`;
  }
  return null;
}

/**
 * Apps may subscribe to server events, their own driver events and their own
 * app events. Wildcards would bypass the per-app checks, so apps can't use them.
 */
export function canSubscribe(scope: TokenScope, event: string): boolean {
  if (scope.kind === 'dashboard') return true;
  if (event.endsWith('*')) return false;
  if (event.startsWith(DRIVER_EVENT_PREFIX)) {
    return canAccessApp(scope, event.slice(DRIVER_EVENT_PREFIX.length));
  }
  const appEvent = APP_EVENT.exec(event);
  if (appEvent?.[1] !== undefined) return canAccessApp(scope, appEvent[1]);
  return true;
}
