/**
 * electron-builder configuration for single-app kiosk bundles.
 *
 * Extends the regular desktop config, including the server, uv and Python
 * resources, but ships exactly one app plus a `kiosk.json` marker in the
 * resources directory; the Electron main process detects that file and boots
 * straight into the app (no dashboard, embedded server on an ephemeral port,
 * isolated data directory).
 *
 * Driven by `scripts/package-kiosk.ts` through environment variables:
 * - GOSAI_KIOSK_STAGING: staging dir containing `apps/<slug>/` and `kiosk.json`
 * - GOSAI_KIOSK_SLUG:    app slug
 * - GOSAI_KIOSK_NAME:    product name (defaults to the slug)
 * - GOSAI_KIOSK_VERSION: app version (defaults to the desktop version)
 */

const path = require('node:path');
const base = require('./electron-builder.config.cjs');

const stagingDir = process.env.GOSAI_KIOSK_STAGING;
const slug = process.env.GOSAI_KIOSK_SLUG;
const name = process.env.GOSAI_KIOSK_NAME || slug;
const version = process.env.GOSAI_KIOSK_VERSION;

if (!stagingDir || !slug) {
  throw new Error(
    'GOSAI_KIOSK_STAGING and GOSAI_KIOSK_SLUG must be set; use `bun run package:kiosk -- <app-dir>`.',
  );
}

// Keep every base resource but the multi-app `apps/` directory, which the
// staged single app replaces.
const inheritedResources = base.extraResources.filter((r) => r.to !== 'apps');

/** @type {import('electron-builder').Configuration} */
module.exports = {
  ...base,
  appId: `com.gosai.kiosk.${slug}`,
  productName: name,
  ...(version ? { extraMetadata: { version } } : {}),
  artifactName: '${productName}-kiosk-${version}-${os}-${arch}.${ext}',
  directories: {
    ...base.directories,
    output: path.resolve(__dirname, 'release', 'kiosk', slug),
  },
  linux: {
    ...base.linux,
    executableName: `gosai-${slug}`,
  },
  win: {
    ...base.win,
    executableName: `gosai-${slug}`,
  },
  extraResources: [
    ...inheritedResources,
    {
      from: path.join(stagingDir, 'apps'),
      to: 'apps',
      filter: ['**/*'],
    },
    {
      from: path.join(stagingDir, 'kiosk.json'),
      to: 'kiosk.json',
    },
  ],
};
