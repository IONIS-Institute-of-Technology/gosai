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
 * Why an app can't run on this SDK, or `null` when its `sdk` range includes
 * `sdkVersion`. Apps without a range are assumed to work.
 */
export function sdkIncompatibility(
  manifest: Pick<AppManifest, 'slug' | 'sdk'>,
  sdkVersion: string = SDK_VERSION,
): string | null {
  if (manifest.sdk === undefined || Bun.semver.satisfies(sdkVersion, manifest.sdk)) return null;
  return (
    `${manifest.slug} needs @gosai/sdk ${manifest.sdk}, but this GOSAI provides ${sdkVersion}. ` +
    'Install a version of the app made for this SDK, or update GOSAI.'
  );
}
