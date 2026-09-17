import { describe, expect, test } from 'bun:test';
import manifest from '../gosai.app.json';
import { DEFAULT_CONFIG, mergeConfig, toMirrorDriverConfig } from '../src/shared/config.js';

function manifestDefault(key: string): unknown {
  for (const group of manifest.settings.groups) {
    for (const field of group.fields) if (field.key === key) return field.default;
  }
  throw new Error(`no field ${key}`);
}

describe('DEFAULT_CONFIG', () => {
  test('comes from the manifest settings', () => {
    expect(DEFAULT_CONFIG).toEqual({
      projection: {
        mode: manifestDefault('projection.mode') as 'direct',
        mirror: manifestDefault('projection.mirror') as boolean,
      },
      sleep: {
        enabled: manifestDefault('sleep.enabled') as boolean,
        wakeConfidence: manifestDefault('sleep.wakeConfidence') as number,
        sleepConfidence: manifestDefault('sleep.sleepConfidence') as number,
        sleepDelaySec: manifestDefault('sleep.sleepDelaySec') as number,
        maxDistanceM: manifestDefault('sleep.maxDistanceM') as number,
      },
    });
  });

  test('is frozen all the way down', () => {
    expect(Object.isFrozen(DEFAULT_CONFIG)).toBe(true);
    expect(Object.isFrozen(DEFAULT_CONFIG.projection)).toBe(true);
    expect(Object.isFrozen(DEFAULT_CONFIG.sleep)).toBe(true);
  });
});

describe('mergeConfig', () => {
  test('returns new objects, never the defaults themselves', () => {
    for (const override of [null, undefined, 'nope', [], {}]) {
      const merged = mergeConfig(DEFAULT_CONFIG, override);
      expect(merged).toEqual(DEFAULT_CONFIG);
      expect(merged).not.toBe(DEFAULT_CONFIG);
      expect(merged.projection).not.toBe(DEFAULT_CONFIG.projection);
      expect(merged.sleep).not.toBe(DEFAULT_CONFIG.sleep);
      expect(Object.isFrozen(merged)).toBe(false);
    }
  });

  test('takes valid values and clamps numbers to the manifest bounds', () => {
    const merged = mergeConfig(DEFAULT_CONFIG, {
      projection: { mode: 'reflection', mirror: false },
      sleep: {
        enabled: false,
        wakeConfidence: 3,
        sleepConfidence: -1,
        sleepDelaySec: 12,
        maxDistanceM: 0,
      },
    });
    expect(merged).toEqual({
      projection: { mode: 'reflection', mirror: false },
      sleep: {
        enabled: false,
        wakeConfidence: 1,
        sleepConfidence: 0,
        sleepDelaySec: 12,
        maxDistanceM: 0.3,
      },
    });
  });

  test('falls back per field on invalid values', () => {
    const merged = mergeConfig(DEFAULT_CONFIG, {
      projection: { mode: 'sideways', mirror: 'yes' },
      sleep: { enabled: 1, wakeConfidence: Number.NaN, sleepDelaySec: '7' },
    });
    expect(merged).toEqual(DEFAULT_CONFIG);
  });
});

describe('toMirrorDriverConfig', () => {
  test('drops a fitted affine when no profile is saved', () => {
    expect(toMirrorDriverConfig(DEFAULT_CONFIG, null)).toEqual({
      mode: 'direct',
      mirror: true,
      width: 1080,
      height: 1920,
      affine: null,
    });
  });

  test('applies the saved profile', () => {
    const update = toMirrorDriverConfig(DEFAULT_CONFIG, {
      tilt_deg: 12,
      scale: 1.1,
      affine: [1, 2, 3, 4],
    });
    expect(update).toMatchObject({ tilt_deg: 12, scale: 1.1, affine: [1, 2, 3, 4] });
  });
});
