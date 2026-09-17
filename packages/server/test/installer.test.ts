import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { installApp, uninstallApp, validateGitSource } from '../src/apps/installer.js';
import { AppManager } from '../src/apps/manager.js';
import type { DriverManager } from '../src/drivers/manager.js';
import { EventBus } from '../src/ipc/bus.js';
import { Logger } from '../src/logger/logger.js';
import type { GosaiPaths } from '../src/paths.js';

function makePaths(): GosaiPaths {
  const tmp = mkdtempSync(join(tmpdir(), 'gosai-installer-'));
  const paths = {
    root: tmp,
    apps: join(tmp, 'apps'),
    logs: join(tmp, 'logs'),
    data: join(tmp, 'data'),
    config: join(tmp, 'config'),
  };
  for (const dir of Object.values(paths)) mkdirSync(dir, { recursive: true });
  return paths;
}

function git(args: string[], cwd: string): void {
  const result = Bun.spawnSync({
    cmd: ['git', ...args],
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'gosai-test',
      GIT_AUTHOR_EMAIL: 'test@gosai.local',
      GIT_COMMITTER_NAME: 'gosai-test',
      GIT_COMMITTER_EMAIL: 'test@gosai.local',
    },
  });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr.toString()}`);
}

/** Creates a git repository holding a minimal app with the given build script. */
function makeRepo(
  root: string,
  slug: string,
  buildScript: string,
  extra: { manifest?: object; packageJson?: object } = {},
): string {
  const repo = join(root, `repo-${slug}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(repo, { recursive: true });
  writeFileSync(
    join(repo, 'gosai.app.json'),
    JSON.stringify({
      slug,
      name: slug,
      version: '0.0.0',
      experiences: [{ slug: 'main', name: 'Main', entry: 'dist/main.js' }],
      ...extra.manifest,
    }),
  );
  writeFileSync(
    join(repo, 'package.json'),
    JSON.stringify({
      name: slug,
      private: true,
      scripts: { build: buildScript },
      ...extra.packageJson,
    }),
  );
  git(['init', '-q'], repo);
  git(['add', '.'], repo);
  git(['commit', '-q', '-m', 'init'], repo);
  return `file://${repo}`;
}

function stagingEntries(paths: GosaiPaths): string[] {
  const staging = join(paths.apps, '.staging');
  return existsSync(staging) ? readdirSync(staging) : [];
}

const logger = new Logger({ logsDir: mkdtempSync(join(tmpdir(), 'gosai-installer-logs-')) });

describe('install source validation', () => {
  test('accepts https and ssh git URLs', () => {
    for (const source of [
      'https://github.com/org/app.git',
      'ssh://git@github.com/org/app.git',
      'git@github.com:org/app.git',
    ]) {
      expect(validateGitSource(source)).toBe(source);
    }
  });

  test('rejects other transports, local paths and option injection', () => {
    for (const source of [
      'ext::sh -c touch% /tmp/pwned',
      'ext::sh',
      'http://github.com/org/app.git',
      'git://github.com/org/app.git',
      'file:///tmp/repo',
      '/tmp/repo',
      '../repo',
      '--upload-pack=touch /tmp/pwned',
      '-uhelp',
      'https://',
      '',
    ]) {
      expect(() => validateGitSource(source)).toThrow();
    }
  });

  test('accepts file URLs only with the test flag', () => {
    expect(validateGitSource('file:///tmp/repo', true)).toBe('file:///tmp/repo');
  });
});

describe('installer', () => {
  test('builds in staging and moves the app into place on success', async () => {
    const paths = makePaths();
    const source = makeRepo(paths.root, 'good-app', 'echo built > built.txt');
    const result = await installApp({
      source,
      paths,
      logger: logger.child('install'),
      allowFileSources: true,
    });
    expect(result.app.installPath).toBe(join(paths.apps, 'good-app'));
    expect(readFileSync(join(paths.apps, 'good-app', 'built.txt'), 'utf8').trim()).toBe('built');
    expect(stagingEntries(paths)).toEqual([]);
  });

  test('streams noisy build output instead of blocking on a full pipe', async () => {
    const paths = makePaths();
    const noisy = `bun -e "for (let i = 0; i < 20000; i++) console.log('x'.repeat(100))"`;
    const source = makeRepo(paths.root, 'noisy-app', noisy);
    await installApp({ source, paths, logger: logger.child('install'), allowFileSources: true });
    expect(existsSync(join(paths.apps, 'noisy-app'))).toBe(true);
  });

  test('refuses file URLs without the test flag', async () => {
    const paths = makePaths();
    const source = makeRepo(paths.root, 'blocked-app', 'true');
    await expect(installApp({ source, paths, logger: logger.child('install') })).rejects.toThrow(
      /https or ssh/,
    );
    expect(existsSync(join(paths.apps, 'blocked-app'))).toBe(false);
  });

  test('cleans up after a failed build and leaves no app behind', async () => {
    const paths = makePaths();
    const source = makeRepo(paths.root, 'broken-app', 'echo build exploded >&2 && exit 3');
    await expect(
      installApp({ source, paths, logger: logger.child('install'), allowFileSources: true }),
    ).rejects.toThrow(/app build failed \(exit 3\)[\s\S]*build exploded/);
    expect(existsSync(join(paths.apps, 'broken-app'))).toBe(false);
    expect(stagingEntries(paths)).toEqual([]);
  });

  test('cleans up after a failed clone', async () => {
    const paths = makePaths();
    await expect(
      installApp({
        source: `file://${join(paths.root, 'missing-repo')}`,
        paths,
        logger: logger.child('install'),
        allowFileSources: true,
      }),
    ).rejects.toThrow(/git clone failed/);
    expect(stagingEntries(paths)).toEqual([]);
  });

  test('kills a step that exceeds its timeout and cleans up', async () => {
    const paths = makePaths();
    const source = makeRepo(paths.root, 'slow-app', 'sleep 5');
    const started = Date.now();
    await expect(
      installApp({
        source,
        paths,
        logger: logger.child('install'),
        allowFileSources: true,
        timeouts: { buildMs: 200 },
      }),
    ).rejects.toThrow(/app build timed out/);
    expect(Date.now() - started).toBeLessThan(4000);
    expect(existsSync(join(paths.apps, 'slow-app'))).toBe(false);
    expect(stagingEntries(paths)).toEqual([]);
  });

  test('never installs the same slug twice at once', async () => {
    const paths = makePaths();
    const source = makeRepo(paths.root, 'twice-app', 'sleep 0.3 && echo ok > built.txt');
    const results = await Promise.allSettled([
      installApp({ source, paths, logger: logger.child('install'), allowFileSources: true }),
      installApp({ source, paths, logger: logger.child('install'), allowFileSources: true }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected');
    expect(String((rejected as PromiseRejectedResult).reason)).toMatch(
      /already (being installed|installed)/,
    );
    expect(existsSync(join(paths.apps, 'twice-app', 'built.txt'))).toBe(true);
    expect(stagingEntries(paths)).toEqual([]);
  });

  test('the app manager removes staging left by an interrupted install', () => {
    const paths = makePaths();
    const leftover = join(paths.apps, '.staging', 'install-1-abcdef');
    mkdirSync(leftover, { recursive: true });
    writeFileSync(join(leftover, 'gosai.app.json'), '{}');
    new AppManager({
      paths,
      logger,
      bus: new EventBus(),
      drivers: {} as DriverManager,
    });
    expect(existsSync(join(paths.apps, '.staging'))).toBe(false);
  });

  test('refuses data an app from another source left, unless asked to reuse it', async () => {
    const paths = makePaths();
    const manager = new AppManager({
      paths,
      logger,
      bus: new EventBus(),
      drivers: {} as DriverManager,
      allowFileInstalls: true,
    });
    const original = makeRepo(paths.root, 'same-slug', 'true');
    const installed = await manager.installFromGit(original, { capabilities: ['logs:read'] });
    expect(installed.grantedCapabilities).toEqual([]);
    writeFileSync(join(paths.data, 'same-slug', 'keep.txt'), 'data');
    expect(await manager.uninstall('same-slug')).toBe(false);

    // The same source may pick its data back up.
    await manager.installFromGit(original);
    await manager.uninstall('same-slug');

    const impostor = makeRepo(paths.root, 'same-slug', 'true');
    const refused = await manager.installFromGit(impostor).catch((err: unknown) => err);
    expect((refused as { details?: unknown }).details).toEqual({ reason: 'app-data-conflict' });
    expect(existsSync(join(paths.apps, 'same-slug'))).toBe(false);
    expect(stagingEntries(paths)).toEqual([]);

    await manager.installFromGit(impostor, { reuseData: true });
    expect(existsSync(join(paths.data, 'same-slug', 'keep.txt'))).toBe(true);
  });

  test('records the git origin of apps installed before install records existed', async () => {
    const paths = makePaths();
    const options = {
      paths,
      logger,
      bus: new EventBus(),
      drivers: {} as DriverManager,
      allowFileInstalls: true,
    };
    const source = makeRepo(paths.root, 'older-app', 'true');
    await new AppManager(options).installFromGit(source);
    rmSync(join(paths.data, 'older-app'), { recursive: true });

    new AppManager(options);
    const record = JSON.parse(readFileSync(join(paths.data, 'older-app', 'install.json'), 'utf8'));
    expect(record).toMatchObject({ source, approvedCapabilities: [] });
  });

  test('refuses leftover data of unknown origin', async () => {
    const paths = makePaths();
    mkdirSync(join(paths.data, 'orphan', 'storage'), { recursive: true });
    const manager = new AppManager({
      paths,
      logger,
      bus: new EventBus(),
      drivers: {} as DriverManager,
      allowFileInstalls: true,
    });
    await expect(manager.installFromGit(makeRepo(paths.root, 'orphan', 'true'))).rejects.toThrow(
      'unknown source',
    );
  });

  test("refuses an app whose sdk range excludes the server's SDK, before building it", async () => {
    const paths = makePaths();
    const source = makeRepo(paths.root, 'future-app', 'echo built > built.txt', {
      manifest: { sdk: '^2.0.0' },
    });
    await expect(
      installApp({
        source,
        paths,
        logger: logger.child('install'),
        allowFileSources: true,
        sdkVersion: '0.1.0',
      }),
    ).rejects.toThrow('future-app needs @gosai/sdk ^2.0.0, but this GOSAI provides 0.1.0');
    expect(existsSync(join(paths.apps, 'future-app'))).toBe(false);
    expect(stagingEntries(paths)).toEqual([]);

    const matching = makeRepo(paths.root, 'current-app', 'true', { manifest: { sdk: '^0.1.0' } });
    await installApp({
      source: matching,
      paths,
      logger: logger.child('install'),
      allowFileSources: true,
      sdkVersion: '0.1.3',
    });
    expect(existsSync(join(paths.apps, 'current-app'))).toBe(true);
  });

  test('installs only runtime dependencies, so dev-only SDK and TypeScript need no registry', async () => {
    const paths = makePaths();
    // Unresolvable dev dependencies would fail any install that included them.
    const source = makeRepo(paths.root, 'dev-only-app', 'echo built > built.txt', {
      packageJson: {
        devDependencies: { '@gosai/sdk': 'workspace:*', typescript: 'workspace:*' },
      },
    });
    await installApp({ source, paths, logger: logger.child('install'), allowFileSources: true });
    expect(existsSync(join(paths.apps, 'dev-only-app', 'node_modules'))).toBe(false);
    expect(readFileSync(join(paths.apps, 'dev-only-app', 'built.txt'), 'utf8').trim()).toBe(
      'built',
    );
  });

  test('fails when installing runtime dependencies fails', async () => {
    const paths = makePaths();
    const source = makeRepo(paths.root, 'workspace-app', 'true', {
      packageJson: { dependencies: { '@gosai/sdk': 'workspace:*' } },
    });
    await expect(
      installApp({ source, paths, logger: logger.child('install'), allowFileSources: true }),
    ).rejects.toThrow(/bun install failed/);
    expect(existsSync(join(paths.apps, 'workspace-app'))).toBe(false);
  });

  test('installs runtime dependencies from a committed lockfile without changing it', async () => {
    const paths = makePaths();
    const dependency = { 'local-dep': 'file:./vendor/local-dep' };

    const locked = (
      slug: string,
      change: (packageJson: Record<string, unknown>) => void,
    ): string => {
      const source = makeRepo(paths.root, slug, 'true');
      const repo = source.slice('file://'.length);
      const dep = join(repo, 'vendor', 'local-dep');
      mkdirSync(dep, { recursive: true });
      writeFileSync(
        join(dep, 'package.json'),
        JSON.stringify({ name: 'local-dep', version: '1.0.0' }),
      );
      writeFileSync(join(dep, 'index.js'), 'export const answer = 42;');
      const packageJson: Record<string, unknown> = {
        name: slug,
        private: true,
        scripts: { build: 'test -f node_modules/local-dep/index.js' },
        dependencies: { ...dependency },
      };
      writeFileSync(join(repo, 'package.json'), JSON.stringify(packageJson));
      const install = Bun.spawnSync({ cmd: ['bun', 'install'], cwd: repo });
      if (install.exitCode !== 0) throw new Error(install.stderr.toString());
      rmSync(join(repo, 'node_modules'), { recursive: true, force: true });
      change(packageJson);
      writeFileSync(join(repo, 'package.json'), JSON.stringify(packageJson));
      git(['add', '.'], repo);
      git(['commit', '-q', '-m', 'lock'], repo);
      return source;
    };

    const good = locked('locked-app', () => undefined);
    await installApp({
      source: good,
      paths,
      logger: logger.child('install'),
      allowFileSources: true,
    });
    expect(existsSync(join(paths.apps, 'locked-app', 'node_modules', 'local-dep'))).toBe(true);

    // A lockfile that no longer matches package.json fails instead of being rewritten.
    const stale = locked('stale-app', (packageJson) => {
      packageJson.dependencies = { ...dependency, 'other-dep': 'file:./vendor/local-dep' };
    });
    await expect(
      installApp({ source: stale, paths, logger: logger.child('install'), allowFileSources: true }),
    ).rejects.toThrow(/bun install failed[\s\S]*lockfile/);
    expect(existsSync(join(paths.apps, 'stale-app'))).toBe(false);
  });

  test('lists an installed app whose sdk range excludes the SDK as invalid', () => {
    const paths = makePaths();
    const appDir = join(paths.apps, 'old-app');
    mkdirSync(appDir, { recursive: true });
    writeFileSync(
      join(appDir, 'gosai.app.json'),
      JSON.stringify({
        slug: 'old-app',
        name: 'Old',
        version: '1.0.0',
        sdk: '~0.0.1',
        experiences: [{ slug: 'main', name: 'Main', entry: 'dist/main.js' }],
      }),
    );
    const manager = new AppManager({
      paths,
      logger,
      bus: new EventBus(),
      drivers: {} as DriverManager,
      sdkVersion: '0.1.0',
    });
    expect(manager.listApps()).toEqual([]);
    expect(manager.listInvalidApps()).toEqual([
      {
        slug: 'old-app',
        builtin: false,
        error: expect.stringContaining(
          'old-app needs @gosai/sdk ~0.0.1, but this GOSAI provides 0.1.0',
        ),
      },
    ]);
  });

  test('uninstall validates the slug', async () => {
    const paths = makePaths();
    await expect(uninstallApp('../apps', paths)).rejects.toThrow(/must match/);
  });
});
