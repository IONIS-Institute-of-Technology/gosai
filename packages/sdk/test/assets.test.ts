import { describe, expect, test } from 'bun:test';
import { createAssetsClient } from '../src/assets.js';

describe('assets', () => {
  const assets = createAssetsClient('http://calibration.localhost:7777', 'calibration');

  test("resolves the app's own files on its origin", () => {
    expect(assets.url('dist/calibrate.js')).toBe(
      'http://calibration.localhost:7777/v1/apps/calibration/static/dist/calibrate.js',
    );
  });

  test("resolves another app's files on that app's origin", () => {
    expect(assets.url('dist/calibration.js', 'interactive-pool')).toBe(
      'http://interactive-pool.localhost:7777/v1/apps/interactive-pool/static/dist/calibration.js',
    );
  });

  test('keeps a non-app server origin as it is', () => {
    const plain = createAssetsClient('http://127.0.0.1:7777', 'demo');
    expect(plain.url('a.png', 'other')).toBe('http://127.0.0.1:7777/v1/apps/other/static/a.png');
  });

  test('rejects an invalid app slug', () => {
    expect(() => assets.url('x.js', '../evil')).toThrow();
  });
});
