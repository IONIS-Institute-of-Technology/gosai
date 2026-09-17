/**
 * Which display an app's window opens on. Shared by the experience windows
 * and the calibration flow. No Electron import, so tests can use it.
 */

import type { ServerClient } from '@gosai/shared/client';

export type DisplayServer = Pick<ServerClient, 'request'>;

export interface DisplaySource {
  listDisplays(): readonly { readonly id: number }[];
  primaryDisplay(): { readonly id: number };
}

export interface ResolvedDisplay {
  readonly displayId: number;
  readonly fullscreen: boolean;
}

/**
 * The app's display assignment, then the global display, then the primary
 * display. An assignment to a display that is gone falls through. A failed
 * settings read counts as no assignment.
 */
export async function resolveAppDisplay(
  server: DisplayServer,
  displays: DisplaySource,
  appSlug: string,
): Promise<ResolvedDisplay> {
  const known = new Set(displays.listDisplays().map((display) => display.id));
  const settings = await server.request('app:config:get', { appSlug }).catch(() => null);
  const fullscreen = settings?.display?.mode !== 'windowed';
  const assigned = settings?.display?.id;
  if (assigned != null && known.has(assigned)) return { displayId: assigned, fullscreen };
  const config = await server.request('config:get').catch(() => null);
  if (config?.displayId != null && known.has(config.displayId)) {
    return { displayId: config.displayId, fullscreen };
  }
  return { displayId: displays.primaryDisplay().id, fullscreen };
}
