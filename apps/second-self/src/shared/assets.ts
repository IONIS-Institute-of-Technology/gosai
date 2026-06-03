/**
 * Resolve an asset URL relative to the built bundle.
 *
 * After bundling, every module's `import.meta.url` points at
 * `.../v1/apps/second-self/static/dist/main.js`, so `../assets/<path>` resolves
 * to `.../v1/apps/second-self/static/assets/<path>` which the GOSAI server
 * serves from the app's install directory.
 */
export function assetUrl(path: string): string {
  const clean = path.replace(/^\/+/, '');
  try {
    return new URL(`../assets/${clean}`, import.meta.url).href;
  } catch {
    return `assets/${clean}`;
  }
}
