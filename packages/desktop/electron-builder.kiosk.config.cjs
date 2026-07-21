/**
 * electron-builder configuration for single-app kiosk bundles.
 *
 * Extends the regular desktop config but ships exactly one app plus a
 * `kiosk.json` marker in the resources directory; the Electron main process
 * detects that file and boots straight into the app (no dashboard, embedded
 * server on an ephemeral port, isolated data directory).
 *
 * Driven by `scripts/package-kiosk.ts` through environment variables:
 * - GOSAI_KIOSK_STAGING: staging dir containing `apps/<slug>/` and `kiosk.json`
 * - GOSAI_KIOSK_SLUG:    app slug
 * - GOSAI_KIOSK_NAME:    product name (defaults to the slug)
 * - GOSAI_KIOSK_VERSION: app version (defaults to the desktop version)
 * - GOSAI_KIOSK_UV_DIR:  dir with uv binaries for the target platform,
 *                        shipped as Resources/bin so the first launch can
 *                        build the Python venv on a clean machine
 */

const path = require('node:path');
const base = require('./electron-builder.config.cjs');

const stagingDir = process.env.GOSAI_KIOSK_STAGING;
const slug = process.env.GOSAI_KIOSK_SLUG;
const name = process.env.GOSAI_KIOSK_NAME || slug;
const version = process.env.GOSAI_KIOSK_VERSION;
const uvDir = process.env.GOSAI_KIOSK_UV_DIR;

if (!stagingDir || !slug) {
  throw new Error(
    'GOSAI_KIOSK_STAGING and GOSAI_KIOSK_SLUG must be set; use `bun run package:kiosk -- <app-dir>`.',
  );
}

// Keep the server + python resources from the base config, but replace the
// multi-app `apps/` directory with the staged single app.
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
    ...(uvDir
      ? [
          {
            from: uvDir,
            to: 'bin',
            filter: ['**/*'],
          },
        ]
      : []),
  ],
};
