import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { resolveKioskConfig, type KioskConfigSources } from '../src/main/kiosk-config.js';
import { parseLaunchArgs } from '../src/main/launch-args.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gosai-kiosk-config-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeApp(dir: string, slug = 'pool'): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'gosai.app.json'),
    JSON.stringify({
      slug,
      default: 'play',
      experiences: [
        { slug: 'play', entry: 'dist/play.js' },
        { slug: 'demo', entry: 'dist/demo.js' },
      ],
    }),
  );
  return dir;
}

function sources(overrides: Partial<KioskConfigSources> & { argv?: string[] }): KioskConfigSources {
  return {
    args: parseLaunchArgs(overrides.argv ?? []),
    env: overrides.env ?? {},
    resourcesPath: overrides.resourcesPath ?? null,
    homedir: join(root, 'home'),
  };
}

describe('resolveKioskConfig', () => {
  test('is null without --kiosk, GOSAI_KIOSK_APP or kiosk.json', () => {
    expect(resolveKioskConfig(sources({}))).toBeNull();
    expect(resolveKioskConfig(sources({ resourcesPath: join(root, 'resources') }))).toBeNull();
  });

  test('uses the manifest defaults for --kiosk <dir>', () => {
    const appDir = writeApp(join(root, 'pool'));
    expect(resolveKioskConfig(sources({ argv: ['--kiosk', appDir] }))).toMatchObject({
      appDir,
      experienceSlug: 'play',
      fullscreen: true,
      homeDir: join(root, 'home', '.gosai-kiosks', 'pool'),
      pythonExtras: [],
      forceCalibrate: false,
    });
  });

  test('prefers flags over environment variables over kiosk.json', () => {
    const resources = join(root, 'resources');
    writeApp(join(resources, 'apps', 'pool'));
    writeFileSync(
      join(resources, 'kiosk.json'),
      JSON.stringify({
        appSlug: 'pool',
        displayIndex: 2,
        pythonExtras: ['speech'],
        fullscreen: false,
      }),
    );

    const fromFile = resolveKioskConfig(sources({ resourcesPath: resources }));
    expect(fromFile).toMatchObject({
      appDir: join(resources, 'apps', 'pool'),
      displayIndex: 2,
      pythonExtras: ['speech'],
      fullscreen: false,
    });

    const env = {
      GOSAI_KIOSK_DISPLAY: '1',
      GOSAI_KIOSK_EXPERIENCE: 'demo',
      GOSAI_KIOSK_PYTHON_EXTRAS: 'realsense',
      GOSAI_HOME: join(root, 'env-home'),
    };
    expect(resolveKioskConfig(sources({ resourcesPath: resources, env }))).toMatchObject({
      displayIndex: 1,
      experienceSlug: 'demo',
      pythonExtras: ['realsense'],
      homeDir: join(root, 'env-home'),
    });

    const argv = [
      '--kiosk-display',
      '0',
      '--kiosk-home',
      join(root, 'flag-home'),
      '--kiosk-calibrate',
    ];
    expect(resolveKioskConfig(sources({ resourcesPath: resources, env, argv }))).toMatchObject({
      displayIndex: 0,
      homeDir: join(root, 'flag-home'),
      forceCalibrate: true,
    });
  });

  test('ignores kiosk.json values when --kiosk picks another app', () => {
    const resources = join(root, 'resources');
    writeFileSync(
      join(mkdirp(resources), 'kiosk.json'),
      JSON.stringify({ appSlug: 'pool', displayIndex: 3 }),
    );
    const other = writeApp(join(root, 'other'), 'other');
    const config = resolveKioskConfig(
      sources({ resourcesPath: resources, argv: ['--kiosk', other] }),
    );
    expect(config?.manifest.slug).toBe('other');
    expect(config?.displayIndex).toBeUndefined();
  });

  test('reports bad input', () => {
    const appDir = writeApp(join(root, 'pool'));
    expect(() => resolveKioskConfig(sources({ argv: ['--kiosk', join(root, 'missing')] }))).toThrow(
      'Not a GOSAI app',
    );
    expect(() =>
      resolveKioskConfig(sources({ argv: ['--kiosk', appDir, '--kiosk-experience', 'nope'] })),
    ).toThrow('has no experience "nope"');
    expect(() =>
      resolveKioskConfig(sources({ argv: ['--kiosk', appDir], env: { GOSAI_KIOSK_DISPLAY: 'x' } })),
    ).toThrow('GOSAI_KIOSK_DISPLAY must be a display index');

    const resources = mkdirp(join(root, 'resources'));
    writeFileSync(join(resources, 'kiosk.json'), JSON.stringify({ appSlug: '../pool' }));
    expect(() => resolveKioskConfig(sources({ resourcesPath: resources }))).toThrow('appSlug');
  });
});

function mkdirp(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}
