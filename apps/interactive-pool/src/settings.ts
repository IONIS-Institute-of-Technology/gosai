/**
 * The app settings declared in `gosai.app.json`, read into a typed object.
 * `rt.settings` already merges the manifest defaults in; the defaults here
 * only cover a value that is missing or has the wrong type.
 */

import type { ExperienceRuntimeContext } from '@gosai/sdk';

export interface PoolSettings {
  readonly debug: {
    /** "INTERACTIVE POOL PROJECT" along the bottom edge. */
    readonly title: boolean;
    /** Canvas frame rate in the top-left corner. */
    readonly renderFps: boolean;
    /** Ball detection rate along the bottom edge. */
    readonly ballFps: boolean;
  };
  readonly live: {
    /** WebSocket URL ball positions are streamed to; empty disables the relay. */
    readonly url: string;
  };
}

export const DEFAULT_SETTINGS: PoolSettings = {
  debug: { title: true, renderFps: false, ballFps: false },
  live: { url: '' },
};

/** Maps the nested object `rt.settings.get()` returns onto {@link PoolSettings}. */
export function readPoolSettings(values: unknown): PoolSettings {
  const debug = field(values, 'debug');
  const url = field(field(values, 'live'), 'url');
  const defaults = DEFAULT_SETTINGS;
  return {
    debug: {
      title: bool(field(debug, 'title'), defaults.debug.title),
      renderFps: bool(field(debug, 'renderFps'), defaults.debug.renderFps),
      ballFps: bool(field(debug, 'ballFps'), defaults.debug.ballFps),
    },
    live: {
      url: typeof url === 'string' ? url.trim() : defaults.live.url,
    },
  };
}

/**
 * Why the relay can't connect to `url`, or `null` when it can. The app's
 * Content Security Policy allows `wss:` anywhere, but a plain `ws:` origin
 * only when the manifest lists it under `network.connect`.
 */
export function relayUrlProblem(url: string, networkConnect: readonly string[]): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `live relay URL "${url}" is not a valid URL`;
  }
  if (parsed.protocol === 'wss:') return null;
  if (parsed.protocol !== 'ws:') {
    return `live relay URL "${url}" must start with wss:// or ws://`;
  }
  const allowed = networkConnect.some((entry) => sameOrigin(entry, parsed));
  if (allowed) return null;
  return (
    `live relay URL "${url}" uses ws://, which the app may only open when gosai.app.json ` +
    `lists "${parsed.protocol}//${parsed.host}" under network.connect (see the ` +
    'interactive-pool README), or use a wss:// relay'
  );
}

/**
 * Moves a relay URL stored by older versions under the `live_server_url`
 * storage key into the `live.url` setting, once.
 */
export async function migrateLegacyRelayUrl(rt: ExperienceRuntimeContext): Promise<void> {
  const legacy = await rt.storage.get<unknown>(LEGACY_RELAY_URL_KEY);
  if (legacy === undefined) return;
  if (typeof legacy === 'string' && legacy.trim() !== '') {
    const current = readPoolSettings(await rt.settings.get());
    if (current.live.url === '') await rt.settings.set({ 'live.url': legacy.trim() });
  }
  await rt.storage.remove(LEGACY_RELAY_URL_KEY);
  rt.log.info('interactive-pool: moved live_server_url into the live.url setting');
}

const LEGACY_RELAY_URL_KEY = 'live_server_url';

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function sameOrigin(entry: string, url: URL): boolean {
  try {
    const allowed = new URL(entry);
    return allowed.protocol === url.protocol && allowed.host === url.host;
  } catch {
    return false;
  }
}
