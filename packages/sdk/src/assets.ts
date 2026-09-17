import { appHostname, appSlugFromHostname } from '@gosai/shared/app-origin';
import { isValidSlug } from '@gosai/shared/slug';
import type { AssetsClient } from './types.js';

/**
 * Resolves app files through the server's static route. Each app's files are
 * served from its own origin, so another app's files resolve against that
 * app's origin.
 */
export function createAssetsClient(serverBaseUrl: string, appSlug: string): AssetsClient {
  return {
    url(path: string, fromApp: string = appSlug): string {
      if (!isValidSlug(fromApp)) throw new Error(`invalid app slug ${JSON.stringify(fromApp)}`);
      const origin = new URL(serverBaseUrl);
      if (fromApp !== appSlug && appSlugFromHostname(origin.hostname) !== null) {
        origin.hostname = appHostname(fromApp);
      }
      const segments = path
        .split('/')
        .filter((segment) => segment !== '' && segment !== '.')
        .map(encodeURIComponent);
      return `${origin.origin}/v1/apps/${fromApp}/static/${segments.join('/')}`;
    },
  };
}
