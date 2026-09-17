import type { AssetsClient } from './types.js';

/** Resolves the app's files through the server's static route, on the app's own origin. */
export function createAssetsClient(serverBaseUrl: string, appSlug: string): AssetsClient {
  return {
    url(path: string): string {
      const origin = new URL(serverBaseUrl).origin;
      const segments = path
        .split('/')
        .filter((segment) => segment !== '' && segment !== '.')
        .map(encodeURIComponent);
      return `${origin}/v1/apps/${appSlug}/static/${segments.join('/')}`;
    },
  };
}
