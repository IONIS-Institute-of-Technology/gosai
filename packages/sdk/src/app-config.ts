import type { AppDeviceSettings } from '@gosai/shared';
import type { AppConfigClient, ServerConnection } from './types.js';

/** The app's device assignments, from the server's `app:config:*` commands and events. */
export class AppConfigClientImpl implements AppConfigClient {
  constructor(
    private readonly appSlug: string,
    private readonly server: ServerConnection,
  ) {}

  get(): Promise<AppDeviceSettings> {
    return this.server.request('app:config:get', { appSlug: this.appSlug });
  }

  onChange(listener: (settings: AppDeviceSettings) => void): () => void {
    return this.server.on('app:config-changed', (change) => {
      if (change.appSlug === this.appSlug) listener(change.settings);
    });
  }
}
