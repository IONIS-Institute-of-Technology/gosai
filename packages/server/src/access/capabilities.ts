/**
 * Decides what a token may do. Every command and event declares the
 * capability it needs (`@gosai/shared/commands` and `@gosai/shared/events`).
 * The dashboard token holds every capability for every app. An app token
 * holds the default capabilities plus the ones its app's manifest requests,
 * and only for the apps the token names.
 */

import {
  ALL_CAPABILITIES,
  CAPABILITY_INFO,
  DEFAULT_APP_CAPABILITIES,
  type Capability,
} from '@gosai/shared/capabilities';
import { COMMANDS } from '@gosai/shared/commands';
import {
  APP_EVENT_CAPABILITY,
  DRIVER_EVENT_CAPABILITY,
  EVENTS,
  isWildcardEvent,
  parseEventName,
  type FixedServerEventName,
} from '@gosai/shared/events';
import type { CommandName, FixedEventPayloads, ParsedCommandRequest } from '@gosai/shared/protocol';
import type { TokenScope } from '@gosai/shared/auth';
import { Capabilities } from '@gosai/shared/capabilities';

export interface Grant {
  readonly scope: TokenScope;
  readonly capabilities: ReadonlySet<Capability>;
}

/**
 * Resolves a token's grant. `requestedBy` returns the capabilities an app's
 * manifest asks for; dashboard-only capabilities are never granted to apps.
 */
export function grantFor(
  scope: TokenScope,
  requestedBy: (appSlug: string) => readonly Capability[] | undefined,
): Grant {
  if (scope.kind === 'dashboard') return { scope, capabilities: new Set(ALL_CAPABILITIES) };
  const requested = (requestedBy(scope.appSlug) ?? []).filter(
    (capability) => CAPABILITY_INFO[capability].grant !== 'dashboard',
  );
  return { scope, capabilities: new Set([...DEFAULT_APP_CAPABILITIES, ...requested]) };
}

export function canAccessApp(grant: Grant, slug: string): boolean {
  return grant.scope.kind === 'dashboard' || grant.scope.slugs.includes(slug);
}

function missing(grant: Grant, capability: Capability | null): string | null {
  if (capability === null || grant.capabilities.has(capability)) return null;
  return `requires the ${capability} capability`;
}

/** Why `grant` may not run `command` at all, before looking at its payload. */
export function commandCapabilityDenial(grant: Grant, command: CommandName): string | null {
  const reason = missing(grant, COMMANDS[command].capability);
  return reason && `${command} ${reason}`;
}

/** Why `grant` may not run `command` with this payload, or `null` when it may. */
export function commandDenial<C extends CommandName>(
  grant: Grant,
  command: C,
  payload: ParsedCommandRequest<C>,
): string | null {
  const capabilityDenial = commandCapabilityDenial(grant, command);
  if (capabilityDenial) return capabilityDenial;
  const outside = (COMMANDS[command].apps?.(payload) ?? []).filter(
    (slug) => !canAccessApp(grant, slug),
  );
  if (outside.length === 0) return null;
  return `${command} for ${outside.join(', ')} is outside the token's apps`;
}

/** Why `grant` may not subscribe to `event`, or `null` when it may. */
export function subscriptionDenial(grant: Grant, event: string): string | null {
  if (isWildcardEvent(event)) return missing(grant, Capabilities.EventsWildcard);
  const parsed = parseEventName(event);
  if (!parsed) return 'unknown event';
  switch (parsed.kind) {
    case 'fixed':
      return missing(grant, EVENTS[parsed.name].capability);
    case 'driver':
      return (
        missing(grant, DRIVER_EVENT_CAPABILITY) ??
        (canAccessApp(grant, parsed.binding) ? null : "outside the token's apps")
      );
    case 'app':
      return (
        missing(grant, APP_EVENT_CAPABILITY) ??
        (canAccessApp(grant, parsed.appSlug) ? null : "outside the token's apps")
      );
  }
}

/**
 * Whether a subscribed client gets this instance of an event. Wildcard
 * subscriptions still only deliver what the grant allows, and events about
 * one app only reach tokens for that app.
 */
export function canReceive(grant: Grant, event: string, payload: unknown): boolean {
  if (grant.scope.kind === 'dashboard') return true;
  if (subscriptionDenial(grant, event) !== null) return false;
  const parsed = parseEventName(event);
  if (parsed?.kind !== 'fixed') return true;
  const apps = scopedApps(parsed.name, payload);
  return apps.every((slug) => canAccessApp(grant, slug));
}

function scopedApps<E extends FixedServerEventName>(event: E, payload: unknown): readonly string[] {
  const spec = EVENTS[event];
  return spec.apps?.(payload as FixedEventPayloads[E]) ?? [];
}
