import { describe, expect, test } from 'bun:test';
import sdkPackage from '../../sdk/package.json' with { type: 'json' };
import { SDK_VERSION, sdkIncompatibility } from '../src/apps/sdk-version.js';

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
});
