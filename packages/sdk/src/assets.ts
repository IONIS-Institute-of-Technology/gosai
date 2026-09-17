import type { AssetsClient } from './types.js';

/** Resolves app files through the server's static route for `appSlug`. */
export function createAssetsClient(serverBaseUrl: string, appSlug: string): AssetsClient {
  const base = `${serverBaseUrl.replace(/\/+$/, '')}/v1/apps/${encodeURIComponent(appSlug)}/static/`;
  return {
    url(path: string): string {
      const segments = path
        .split('/')
        .filter((segment) => segment !== '' && segment !== '.')
        .map(encodeURIComponent);
      return base + segments.join('/');
    },
  };
}
