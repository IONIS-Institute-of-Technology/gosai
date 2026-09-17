/**
 * electron-builder configuration for GOSAI Desktop.
 *
 * The packaged app ships:
 * - The Electron main, preload and renderer bundles (out/, from electron-vite).
 * - The bun-compiled server at `resources/server/gosai-server`.
 * - `uv` at `resources/bin/uv`, which builds the Python environment on first
 *   launch, and `resources/python-runtime.json` describing that environment.
 * - The Python source tree at `resources/python/`.
 * - The built-in apps under `resources/apps/` and the SDK runtime bundle.
 *
 * The server, uv and python-runtime.json come from
 * `bun scripts/prepare-bundle.ts --target <os>-<arch>`, which the `dist:*`
 * scripts run. The `package:*` scripts in the root package.json also build
 * the workspace and the apps first.
 */

const fs = require('node:fs');
const path = require('node:path');
const { Arch } = require('electron-builder');

// package.json declares a semver range, but electron-builder needs the exact
// version to download matching platform binaries. Bun hoists electron to the
// workspace root, where electron-builder does not look, so resolve the
// installed version explicitly.
const electronVersion = require('electron/package.json').version;

const bundleDir = path.resolve(__dirname, 'release', 'bundle');
const PLATFORM_OS = { darwin: 'mac', linux: 'linux', win32: 'win' };

/** Fails early when prepare-bundle has not run for the target being packed. */
async function checkBundle(context) {
  const os = PLATFORM_OS[context.electronPlatformName];
  const target = `${os}-${Arch[context.arch]}`;
  const exe = os === 'win' ? '.exe' : '';
  const required = [
    path.join(bundleDir, target, 'server', `gosai-server${exe}`),
    path.join(bundleDir, target, 'bin', `uv${exe}`),
    path.join(bundleDir, 'python-runtime.json'),
  ];
  for (const file of required) {
    if (!fs.existsSync(file)) {
      throw new Error(
        `${file} is missing; run \`bun scripts/prepare-bundle.ts --target ${target}\` first`,
      );
    }
  }
}

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
  files: ['out/{main,preload,renderer}/**/*', '!**/*.map'],
  beforePack: checkBundle,
  extraResources: [
    {
      from: path.resolve(__dirname, '..', 'sdk', 'dist'),
      to: 'sdk',
      filter: ['browser.js'],
    },
    {
      from: path.join(bundleDir, '${os}-${arch}', 'server'),
      to: 'server',
    },
    {
      from: path.join(bundleDir, '${os}-${arch}', 'bin'),
      to: 'bin',
    },
    {
      from: path.join(bundleDir, 'python-runtime.json'),
      to: 'python-runtime.json',
    },
    {
      from: path.resolve(__dirname, '..', '..', 'python'),
      to: 'python',
      filter: [
        '**/*',
        '!.venv/**',
        '!**/__pycache__/**',
        '!**/*.pyc',
        '!**/.pytest_cache/**',
        '!**/.ruff_cache/**',
      ],
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
    target: [{ target: 'dmg', arch: ['arm64'] }],
    hardenedRuntime: false,
    gatekeeperAssess: false,
  },
  linux: {
    // Derived from the npm package name (@gosai/desktop) otherwise, which
    // contains characters that are invalid in file paths.
    executableName: 'gosai',
    category: 'Development',
    target: [{ target: 'AppImage', arch: ['x64'] }],
  },
  win: {
    executableName: 'GOSAI',
    target: [{ target: 'nsis', arch: ['x64'] }],
  },
};
