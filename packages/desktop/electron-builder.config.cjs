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

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'com.gosai.desktop',
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
      filter: ['**/*', '!**/node_modules/**'],
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
    category: 'Development',
    target: [
      {
        target: 'AppImage',
        arch: ['x64'],
      },
    ],
  },
};
