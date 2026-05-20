/**
 * App installation. Clones a git repository into the apps directory, validates
 * its manifest, and (optionally) installs Python requirements via uv and
 * JavaScript dependencies + build steps via bun.
 *
 * Each step is best-effort and surfaces clear errors if anything goes wrong.
 * A failed install always cleans up the staged directory.
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ChildLogger } from '../logger/index.js';
import type { GosaiPaths } from '../paths.js';
import { parseManifest, type DiscoveredApp } from './manifest.js';

export interface InstallOptions {
  readonly source: string;
  readonly slugOverride?: string;
  readonly logger: ChildLogger;
  readonly paths: GosaiPaths;
  readonly pythonDir?: string;
}

export interface InstallResult {
  readonly app: DiscoveredApp;
  readonly cloned: boolean;
}

const GIT_TIMEOUT_MS = 5 * 60 * 1000;

export async function installApp(options: InstallOptions): Promise<InstallResult> {
  const { source, logger, paths } = options;
  const stagingRoot = join(paths.apps, '.staging');
  mkdirSync(stagingRoot, { recursive: true });
  const stagingPath = join(stagingRoot, `install-${Date.now()}-${randomSuffix()}`);

  try {
    logger.info(`cloning ${source}`);
    await runGitClone(source, stagingPath);
    const manifestPath = join(stagingPath, 'gosai.app.json');
    if (!existsSync(manifestPath)) {
      throw new Error('Cloned repository does not contain gosai.app.json');
    }
    const manifest = parseManifest(manifestPath);
    const slug = options.slugOverride ?? manifest.slug;
    const finalPath = join(paths.apps, slug);
    if (existsSync(finalPath)) {
      throw new Error(`App ${slug} is already installed at ${finalPath}`);
    }
    safeRename(stagingPath, finalPath);

    // Install JS deps and build if the app has a package.json. This is the
    // overwhelming-majority case for SDK-based apps.
    await maybeInstallJsDeps({ appPath: finalPath, logger });
    await maybeRunBuild({ appPath: finalPath, logger });

    if (manifest.python?.requirements && options.pythonDir) {
      await installPythonRequirements({
        appPath: finalPath,
        requirements: manifest.python.requirements,
        logger,
      });
    }
    return {
      cloned: true,
      app: {
        manifest,
        installPath: finalPath,
        manifestPath: join(finalPath, 'gosai.app.json'),
      },
    };
  } catch (err) {
    if (existsSync(stagingPath)) {
      try {
        rmSync(stagingPath, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
    throw err;
  }
}

export async function uninstallApp(slug: string, paths: GosaiPaths): Promise<void> {
  const target = join(paths.apps, slug);
  if (!existsSync(target)) {
    throw new Error(`App ${slug} is not installed`);
  }
  rmSync(target, { recursive: true, force: true });
}

export function linkBuiltinApp(sourcePath: string, paths: GosaiPaths): DiscoveredApp {
  const manifestPath = join(sourcePath, 'gosai.app.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`Built-in app at ${sourcePath} has no gosai.app.json`);
  }
  const manifest = parseManifest(manifestPath);
  return {
    manifest: { ...manifest, builtin: true },
    installPath: sourcePath,
    manifestPath,
  };
  void paths;
}

async function runGitClone(source: string, dest: string): Promise<void> {
  const child = Bun.spawn({
    cmd: ['git', 'clone', '--depth', '1', source, dest],
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timeout = setTimeout(() => {
    try {
      child.kill();
    } catch {
      // ignore
    }
  }, GIT_TIMEOUT_MS);
  const code = await child.exited;
  clearTimeout(timeout);
  if (code !== 0) {
    const stderr = await new Response(child.stderr).text();
    throw new Error(`git clone failed (exit ${code}): ${stderr.trim() || 'unknown error'}`);
  }
}

interface PyInstallOptions {
  readonly appPath: string;
  readonly requirements: string;
  readonly logger: ChildLogger;
}

async function installPythonRequirements(opts: PyInstallOptions): Promise<void> {
  const requirementsPath = join(opts.appPath, opts.requirements);
  if (!existsSync(requirementsPath)) {
    opts.logger.warn('declared requirements file missing', { path: requirementsPath });
    return;
  }
  opts.logger.info('installing python requirements via uv pip', {
    requirements: requirementsPath,
  });
  const child = Bun.spawn({
    cmd: ['uv', 'pip', 'install', '-r', requirementsPath],
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const code = await child.exited;
  if (code !== 0) {
    const stderr = await new Response(child.stderr).text();
    throw new Error(`uv pip install failed: ${stderr.trim() || 'unknown error'}`);
  }
}

interface JsInstallOptions {
  readonly appPath: string;
  readonly logger: ChildLogger;
}

async function maybeInstallJsDeps(opts: JsInstallOptions): Promise<void> {
  const packageJsonPath = join(opts.appPath, 'package.json');
  if (!existsSync(packageJsonPath)) return;

  // If the app's only declared dependency is `@gosai/sdk` (provided at runtime
  // by GOSAI), we can skip the install step entirely - bun would otherwise
  // fail because `workspace:*` references can't resolve outside the monorepo.
  let parsed: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  try {
    parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  } catch (err) {
    opts.logger.warn('invalid package.json, skipping install', { err: String(err) });
    return;
  }
  const deps = { ...parsed.dependencies, ...parsed.devDependencies };
  const externalDeps = Object.keys(deps).filter((k) => k !== '@gosai/sdk');
  if (externalDeps.length === 0) {
    opts.logger.info('no non-SDK dependencies declared, skipping bun install');
    return;
  }

  opts.logger.info('installing app dependencies via bun', { count: externalDeps.length });
  const child = Bun.spawn({
    cmd: ['bun', 'install', '--silent'],
    cwd: opts.appPath,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const code = await child.exited;
  if (code !== 0) {
    const stderr = await new Response(child.stderr).text();
    // Don't hard-fail if the SDK workspace alias is missing; the build step
    // marks it as `--external` so it doesn't need to be present.
    if (stderr.includes('@gosai/sdk') && stderr.includes('workspace')) {
      opts.logger.warn('bun install warned about @gosai/sdk workspace ref; continuing', {
        stderr: stderr.trim().slice(0, 200),
      });
      return;
    }
    throw new Error(`bun install failed: ${stderr.trim() || 'unknown error'}`);
  }
}

async function maybeRunBuild(opts: JsInstallOptions): Promise<void> {
  const packageJson = join(opts.appPath, 'package.json');
  if (!existsSync(packageJson)) return;
  let parsed: { scripts?: Record<string, string> };
  try {
    parsed = JSON.parse(readFileSync(packageJson, 'utf8')) as {
      scripts?: Record<string, string>;
    };
  } catch (err) {
    opts.logger.warn('invalid package.json, skipping build', { err: String(err) });
    return;
  }
  if (!parsed.scripts?.build) return;
  opts.logger.info('running app build script');
  const child = Bun.spawn({
    cmd: ['bun', 'run', 'build'],
    cwd: opts.appPath,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const code = await child.exited;
  if (code !== 0) {
    const stderr = await new Response(child.stderr).text();
    throw new Error(`app build failed: ${stderr.trim() || 'unknown error'}`);
  }
}

function safeRename(from: string, to: string): void {
  // fs.renameSync is atomic on the same volume but cross-volume moves throw.
  try {
    const fs = require('node:fs') as typeof import('node:fs');
    fs.renameSync(from, to);
  } catch {
    const fs = require('node:fs') as typeof import('node:fs');
    fs.cpSync(from, to, { recursive: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}
