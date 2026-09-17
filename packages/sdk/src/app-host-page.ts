/**
 * The app host page script. The server serves a static page on each app's
 * origin (`http://<slug>.localhost:<port>/`) that loads this script, which:
 *
 * 1. reads the app slug from the hostname and the launch parameters from the
 *    query string, keeping the token out of the URL once read,
 * 2. fetches the app's manifest and imports the experience entry,
 * 3. runs it, and stops it on `pagehide` or when the embedder calls
 *    `window.gosaiHost.stop()` (Electron main does, before closing a window).
 */

import type { AppManifest } from '@gosai/shared';
import { appSlugFromHostname } from '@gosai/shared/app-origin';
import { runExperience, type RuntimeHandle } from './runtime.js';
import type { ExperienceDefinition } from './types.js';

/** What the page exposes as `window.gosaiHost`. */
export interface AppHostControl {
  /** Stops the experience, or cancels it while it starts. */
  stop(): Promise<void>;
}

const TOKEN_PARAM = 'token';
const TOKEN_STORAGE_KEY = 'gosai:token';

export interface LaunchParams {
  /** Every query parameter except the token. */
  readonly params: Readonly<Record<string, string>>;
  readonly token: string | null;
  /** The URL without the token, to put back in the address bar. */
  readonly cleanUrl: string;
}

/** Splits the token from the other query parameters. */
export function readLaunchParams(href: string): LaunchParams {
  const url = new URL(href);
  const token = url.searchParams.get(TOKEN_PARAM);
  url.searchParams.delete(TOKEN_PARAM);
  return {
    params: Object.fromEntries(url.searchParams),
    token,
    cleanUrl: url.toString(),
  };
}

/** Boots the page. Never rejects; failures are shown in the window. */
export async function bootAppHost(): Promise<void> {
  document.documentElement.style.background = '#000';

  const controller = new AbortController();
  let handle: RuntimeHandle | null = null;
  let starting: Promise<void> = Promise.resolve();

  const control: AppHostControl = {
    async stop(): Promise<void> {
      controller.abort();
      await starting.catch(() => undefined);
      await handle?.stop();
    },
  };
  Object.defineProperty(window, 'gosaiHost', { value: Object.freeze(control) });
  window.addEventListener('pagehide', () => void control.stop(), { once: true });

  starting = (async () => {
    const appSlug = appSlugFromHostname(location.hostname);
    if (!appSlug) throw new Error(`${location.host} is not a GOSAI app origin`);

    const launch = readLaunchParams(location.href);
    if (launch.token !== null) {
      // Keep the token for reloads, but out of the URL and the history.
      sessionStorage.setItem(TOKEN_STORAGE_KEY, launch.token);
      history.replaceState(history.state, '', launch.cleanUrl);
    }
    const token = launch.token ?? sessionStorage.getItem(TOKEN_STORAGE_KEY);

    const manifest = await fetchManifest(controller.signal);
    const experienceSlug =
      launch.params.experience ?? manifest.default ?? manifest.experiences[0]?.slug;
    const experience = manifest.experiences.find((e) => e.slug === experienceSlug);
    if (!experience) {
      throw new Error(`${manifest.name} has no experience "${experienceSlug ?? ''}"`);
    }
    document.title = `${experience.name} - ${manifest.name}`;

    const entryUrl = new URL(`/v1/apps/${appSlug}/static/${experience.entry}`, location.origin);
    const module = (await import(/* @vite-ignore */ entryUrl.href)) as { default?: unknown };
    const definition = module.default;
    if (!isExperienceDefinition(definition)) {
      throw new Error(`${experience.entry} does not default-export defineExperience(...)`);
    }
    if (controller.signal.aborted) return;

    const driverBinding = launch.params.driverBinding;
    handle = await runExperience(definition, {
      appSlug,
      experienceSlug: experience.slug,
      manifest,
      serverBaseUrl: location.origin,
      params: launch.params,
      signal: controller.signal,
      ...(token ? { authToken: token } : {}),
      ...(driverBinding ? { driverBinding } : {}),
      onFatalError: (err) => showError('The experience stopped after repeated render errors', err),
    });
  })();

  try {
    await starting;
  } catch (err) {
    if (!controller.signal.aborted) showError('The experience failed to start', err);
  }
}

async function fetchManifest(signal: AbortSignal): Promise<AppManifest> {
  const res = await fetch('/gosai.app.json', { signal });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `could not load the app manifest (HTTP ${res.status})`);
  }
  return (await res.json()) as AppManifest;
}

function isExperienceDefinition(value: unknown): value is ExperienceDefinition<unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const hooks = value as Record<string, unknown>;
  return ['init', 'start', 'render', 'stop'].every(
    (hook) => hooks[hook] === undefined || typeof hooks[hook] === 'function',
  );
}

function showError(title: string, err: unknown): void {
  console.error(title, err);
  const panel = document.createElement('div');
  panel.style.cssText =
    'position:fixed;inset:0;z-index:2147483647;display:flex;flex-direction:column;' +
    'align-items:center;justify-content:center;gap:16px;padding:32px;background:#000;' +
    'color:#fca5a5;font:14px ui-monospace,monospace;text-align:center;';
  const heading = document.createElement('h1');
  heading.style.cssText = 'margin:0;font-size:18px;font-weight:600;';
  heading.textContent = title;
  const detail = document.createElement('p');
  detail.style.cssText = 'margin:0;max-width:60ch;color:#d4d4d4;white-space:pre-wrap;';
  detail.textContent = err instanceof Error ? err.message : String(err);
  panel.append(heading, detail);
  document.body.append(panel);
}
