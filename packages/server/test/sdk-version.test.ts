import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'bun:test';
import sdkPackage from '../../sdk/package.json' with { type: 'json' };
import { validateManifest } from '../src/apps/manifest.js';
import { comparableSdkVersion, SDK_VERSION, sdkIncompatibility } from '../src/apps/sdk-version.js';

const repoRoot = resolve(import.meta.dir, '..', '..', '..');

describe('sdk version contract', () => {
  test("the server's SDK version is the SDK package's", () => {
    expect(SDK_VERSION).toBe(sdkPackage.version);
  });

  test('accepts apps whose range includes the version, and apps without a range', () => {
    for (const sdk of [undefined, '^0.1.0', '~0.1', '0.1.x', '>=0.1.0 <1', '^0.0.9 || ^0.1.0']) {
      expect(sdkIncompatibility({ slug: 'app', sdk }, '0.1.4')).toBeNull();
    }
  });

  test('explains why an app is refused', () => {
    expect(sdkIncompatibility({ slug: 'app', sdk: '^0.2.0' }, '0.1.4')).toBe(
      'app needs @gosai/sdk ^0.2.0, but this GOSAI provides 0.1.4. ' +
        'Install a version of the app made for this SDK, or update GOSAI.',
    );
    // In 0.x a minor version may break the API, so ^0.1.0 excludes 0.2.0.
    expect(sdkIncompatibility({ slug: 'app', sdk: '^0.1.0' }, '0.2.0')).not.toBeNull();
  });

  test('a prerelease SDK counts as the release it leads to', () => {
    expect(comparableSdkVersion('0.2.0-rc.0')).toBe('0.2.0');
    expect(comparableSdkVersion('1.0.0+build.5')).toBe('1.0.0');
    expect(comparableSdkVersion('0.1.0')).toBe('0.1.0');
    for (const sdk of ['^0.2.0', '*', '>=0.2.0 <0.3.0', '0.2.x']) {
      expect({ sdk, error: sdkIncompatibility({ slug: 'app', sdk }, '0.2.0-rc.0') }).toEqual({
        sdk,
        error: null,
      });
    }
    expect(sdkIncompatibility({ slug: 'app', sdk: '^0.1.0' }, '0.2.0-rc.0')).not.toBeNull();
  });

  test("every bundled manifest and the template's SDK dependency include the SDK version", () => {
    const manifests = [
      ...readdirSync(join(repoRoot, 'apps'), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join('apps', entry.name, 'gosai.app.json')),
      join('templates', 'basic', 'gosai.app.json'),
    ];
    expect(manifests.length).toBeGreaterThanOrEqual(4);
    for (const path of manifests) {
      const manifest = validateManifest(
        path,
        JSON.parse(readFileSync(join(repoRoot, path), 'utf8')),
      );
      // Bump these ranges together with packages/sdk/package.json.
      expect({ path, sdk: manifest.sdk, error: sdkIncompatibility(manifest) }).toEqual({
        path,
        sdk: expect.any(String),
        error: null,
      });
    }
    const template = JSON.parse(
      readFileSync(join(repoRoot, 'templates', 'basic', 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const range = template.devDependencies?.['@gosai/sdk'] ?? template.dependencies?.['@gosai/sdk'];
    expect(Bun.semver.satisfies(comparableSdkVersion(SDK_VERSION), range ?? '')).toBe(true);
  });
});
