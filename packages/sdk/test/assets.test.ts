import { describe, expect, test } from 'bun:test';
import { createAssetsClient } from '../src/assets.js';

describe('assets', () => {
  test("resolves the app's own files on its origin", () => {
    const assets = createAssetsClient('http://calibration.localhost:7777', 'calibration');
    expect(assets.url('dist/calibrate.js')).toBe(
      'http://calibration.localhost:7777/v1/apps/calibration/static/dist/calibrate.js',
    );
  });

  test('keeps a non-app server origin as it is', () => {
    const plain = createAssetsClient('http://127.0.0.1:7777/', 'demo');
    expect(plain.url('a.png')).toBe('http://127.0.0.1:7777/v1/apps/demo/static/a.png');
  });
});
