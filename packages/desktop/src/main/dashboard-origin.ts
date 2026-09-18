/**
 * The dashboard loads from `gosai://dashboard/`, a scheme main registers with
 * the privileges of a web origin, instead of `file://`. Its origin is then
 * `gosai://dashboard`, which the server's origin allowlist names exactly,
 * where a `file://` page sends `file://` or `null` like any local file.
 *
 * No Electron import, so tests can check it. windows.ts registers the scheme
 * and serves the built renderer with `dashboardFile`.
 */

import { isAbsolute, join, relative } from 'node:path';

export const DASHBOARD_SCHEME = 'gosai';
const DASHBOARD_HOST = 'dashboard';
export const DASHBOARD_ORIGIN = `${DASHBOARD_SCHEME}://${DASHBOARD_HOST}`;

/**
 * The file under `rendererDir` a dashboard URL names, or null when the URL
 * isn't the dashboard's or points outside `rendererDir`.
 */
export function dashboardFile(rendererDir: string, url: string): string | null {
  let parsed: URL;
  let path: string;
  try {
    parsed = new URL(url);
    path = decodeURIComponent(parsed.pathname);
  } catch {
    return null;
  }
  // URL.origin is "null" for schemes the URL standard doesn't know.
  if (parsed.protocol !== `${DASHBOARD_SCHEME}:` || parsed.host !== DASHBOARD_HOST) return null;
  if (path.includes('\0')) return null;
  const file = join(rendererDir, path);
  const rel = relative(rendererDir, file);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null;
  return file;
}
