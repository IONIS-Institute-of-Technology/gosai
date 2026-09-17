/**
 * Resolves the GOSAI server address and token for this window. The Electron
 * main process appends `?serverPort=`, `serverHost=` and `token=` to every
 * renderer URL it opens, so windows keep working when the server runs on an
 * ephemeral port (kiosk mode / multiple instances). The address falls back to
 * the historical default of 127.0.0.1:7777 for dev setups.
 */

const params = new URLSearchParams(window.location.search);

export const SERVER_HOST: string = params.get('serverHost') || '127.0.0.1';
export const SERVER_PORT: number = Number.parseInt(params.get('serverPort') || '7777', 10);

export const SERVER_BASE_URL = `http://${SERVER_HOST}:${SERVER_PORT}`;
export const SERVER_WS_URL = `ws://${SERVER_HOST}:${SERVER_PORT}/ws`;

/** Dashboard token for the dashboard window, app token for app windows. */
export const SERVER_TOKEN: string = params.get('token') ?? '';

/** Headers for HTTP calls to the server. */
export function serverHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return SERVER_TOKEN ? { ...extra, authorization: `Bearer ${SERVER_TOKEN}` } : extra;
}
