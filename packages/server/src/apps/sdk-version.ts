/**
 * The SDK version contract. The server serves one build of `@gosai/sdk` to
 * app windows, under `/sdk/<version>/`, and apps name the SDK versions they
 * work with in their manifest's `sdk` range.
 */

import { version } from '@gosai/sdk/package.json' with { type: 'json' };
import type { AppManifest } from '@gosai/shared';

/** Version of the SDK this server serves to app windows. */
export const SDK_VERSION: string = version;

/**
 * The version an app's `sdk` range is compared with: `sdkVersion` without
 * prerelease or build tags. Semver ranges never match a prerelease unless
 * they name one, so without this `0.2.0-rc.0` would fail `^0.2.0` and even
 * `*`. A release candidate counts as the release it leads to.
 */
export function comparableSdkVersion(sdkVersion: string): string {
  return sdkVersion.replace(/[-+].*$/, '');
}

/**
 * Why an app can't run on this SDK, or `null` when its `sdk` range includes
 * `sdkVersion` (see {@link comparableSdkVersion} for prereleases). Apps
 * without a range are assumed to work.
 */
export function sdkIncompatibility(
  manifest: Pick<AppManifest, 'slug' | 'sdk'>,
  sdkVersion: string = SDK_VERSION,
): string | null {
  if (manifest.sdk === undefined) return null;
  if (Bun.semver.satisfies(comparableSdkVersion(sdkVersion), manifest.sdk)) return null;
  return (
    `${manifest.slug} needs @gosai/sdk ${manifest.sdk}, but this GOSAI provides ${sdkVersion}. ` +
    'Install a version of the app made for this SDK, or update GOSAI.'
  );
}
