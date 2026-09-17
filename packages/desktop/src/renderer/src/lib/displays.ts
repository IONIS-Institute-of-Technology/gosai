import type { AppDeviceSettings, DisplayMode } from '@gosai/shared';
import type { ServerClient } from '@gosai/shared/client';

async function pickDisplay(client: ServerClient): Promise<{ id: number; label: string } | null> {
  const api = window.gosai;
  if (!api) return null;
  const { displays, primary } = await api.displays.list();
  if (displays.length <= 1) return primary;

  try {
    const config = await client.request('config:get');
    if (config.displayId != null) {
      const match = displays.find((d) => d.id === config.displayId);
      if (match) return match;
    }
  } catch {
    // Fall through to primary if config fetch fails.
  }
  return primary;
}

/**
 * Resolve which display (and fullscreen/windowed mode) an app's window should
 * open on, honouring the app's per-app settings and falling back to the global
 * display selection. Displays are shareable, so two apps may pick the same one.
 */
export async function pickDisplayForApp(
  client: ServerClient,
  appSlug: string,
): Promise<{ display: { id: number; label: string } | null; mode: DisplayMode }> {
  const api = window.gosai;
  if (!api) return { display: null, mode: 'fullscreen' };

  let settings: AppDeviceSettings = {};
  try {
    settings = await client.request('app:config:get', { appSlug });
  } catch {
    // No per-app settings yet.
  }
  const mode = settings.display?.mode ?? 'fullscreen';
  const desiredId = settings.display?.id;

  if (desiredId != null) {
    const { displays } = await api.displays.list();
    const match = displays.find((d) => d.id === desiredId);
    if (match) return { display: match, mode };
  }

  const fallback = await pickDisplay(client);
  return { display: fallback, mode };
}
