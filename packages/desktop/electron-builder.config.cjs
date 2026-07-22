/**
 * electron-builder configuration for GOSAI Desktop.
 *
 * The packaged app ships:
 * - The Electron renderer + main bundle (out/, compiled by electron-vite).
 * - A bun-compiled, single-file GOSAI server binary at
 *   `Contents/Resources/server/gosai-server`.
 * - The Python source tree at `Contents/Resources/python/` so `uv` can build
 *   a virtual environment on first launch (apps that ship Python drivers
 *   reuse this environment).
 * - The built-in apps under `Contents/Resources/apps/`.
 *
 * Building requires:
 * - `bun run build` at the repo root (for shared, sdk, server, desktop, and
 *   the built-in apps).
 * - `bun build packages/server/src/index.ts --compile --target=bun-darwin-arm64 --outfile=release/server/gosai-server`
 *   (or platform equivalent) before invoking electron-builder.
 *
 * The release scripts in the root package.json wire these together.
 */

const path = require('node:path');

// package.json declares a semver range, but electron-builder needs the exact
// version to download matching platform binaries. Bun hoists electron to the
// workspace root, where electron-builder does not look, so resolve the
// installed version explicitly.
const electronVersion = require('electron/package.json').version;

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'com.gosai.desktop',
  electronVersion,
  productName: 'GOSAI',
  copyright: 'GOSAI Contributors',
  artifactName: '${productName}-${version}-${os}-${arch}.${ext}',
  directories: {
    output: path.resolve(__dirname, 'release'),
    buildResources: path.resolve(__dirname, 'build'),
  },
  asar: true,
  files: ['out/**/*', 'package.json', '!**/*.map'],
  extraResources: [
    {
      from: path.resolve(__dirname, '..', 'sdk', 'dist'),
      to: 'sdk',
      filter: ['browser.js'],
    },
    {
      from: path.resolve(__dirname, 'release/server'),
      to: 'server',
      filter: ['**/*'],
    },
    {
      from: path.resolve(__dirname, '..', '..', 'python'),
      to: 'python',
      filter: ['**/*', '!.venv/**', '!**/__pycache__/**', '!**/*.pyc', '!**/.pytest_cache/**'],
    },
    {
      from: path.resolve(__dirname, '..', '..', 'apps'),
      to: 'apps',
      // `_data` / `_config` are per-install server state (app storage, device
      // assignments); they must never ship in a package.
      filter: ['**/*', '!**/node_modules/**', '!**/_data/**', '!**/_config/**'],
    },
  ],
  mac: {
    category: 'public.app-category.developer-tools',
    target: [
      {
        target: 'dmg',
        arch: ['arm64', 'x64'],
      },
    ],
    hardenedRuntime: false,
    gatekeeperAssess: false,
    entitlements: undefined,
    icon: undefined,
  },
  linux: {
    // Derived from the npm package name (@gosai/desktop) otherwise, which
    // contains characters that are invalid in file paths.
    executableName: 'gosai',
    category: 'Development',
    target: [
      {
        target: 'AppImage',
        arch: ['x64'],
      },
    ],
  },
};
