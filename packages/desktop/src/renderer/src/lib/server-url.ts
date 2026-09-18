/**
 * The GOSAI server address and token for the dashboard. Electron main appends
 * `?serverHost=`, `serverPort=` and `token=` to the dashboard URL, since the
 * embedded server listens on an ephemeral port.
 */

import type { AppManifest } from '@gosai/shared';

const params = new URLSearchParams(window.location.search);

export const SERVER_HOST: string = params.get('serverHost') || '127.0.0.1';
export const SERVER_PORT: number = Number.parseInt(params.get('serverPort') || '7777', 10);

export const SERVER_BASE_URL = `http://${SERVER_HOST}:${SERVER_PORT}`;
export const SERVER_WS_URL = `ws://${SERVER_HOST}:${SERVER_PORT}/ws`;

/** Dashboard token for this window. */
export const SERVER_TOKEN: string = params.get('token') ?? '';

/**
 * URL of the app's icon, or `null` when it declares none. Load it with
 * `crossOrigin="anonymous"`: a plain `<img>` request carries `Origin: null`,
 * which the server refuses, and a CORS one the dashboard's origin.
 */
export function appIconUrl(manifest: Pick<AppManifest, 'slug' | 'icon'>): string | null {
  if (!manifest.icon) return null;
  return `${SERVER_BASE_URL}/v1/apps/${manifest.slug}/static/${encodeURI(manifest.icon)}`;
}
