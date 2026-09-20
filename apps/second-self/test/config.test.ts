import { describe, expect, test } from 'bun:test';
import manifest from '../gosai.app.json';
import {
  DEFAULT_CONFIG,
  DRIVER_IPD_MM,
  GENERIC_IRIS_MM,
  mergeConfig,
  parseMirrorProfile,
  parseStoredLens,
  toMirrorDriverConfig,
  type MirrorProfile,
  type StoredLens,
} from '../src/shared/config.js';

function manifestField(key: string): Record<string, unknown> {
  for (const group of manifest.settings.groups) {
    for (const field of group.fields) if (field.key === key) return field;
  }
  throw new Error(`no field ${key}`);
}

function manifestDefault(key: string): unknown {
  return manifestField(key).default;
}

const RIG: MirrorProfile = {
  version: 2,
  rig: {
    rotation: [0.01, 0.02, 0.03],
    center_mm: [10, -20, 1500],
    width_mm: 392.85,
    height_mm: 698.4,
    gap_mm: 6,
    camera_height_mm: 1720,
    iris_mm: 12.32,
  },
  trim_px: [4, -3],
  measurements: {
    screen_width_mm: 392.85,
    screen_height_mm: 698.4,
    gap_mm: 6,
    camera_height_mm: 1720,
  },
  fit: { rms_mm: 3.2, predicted_error_mm: 5.1, quality: 'good', samples: 9 },
  updatedAt: 1700000000000,
};

const LENS: StoredLens = {
  lens: {
    width: 1280,
    height: 720,
    fx: 900,
    fy: 902,
    cx: 640,
    cy: 360,
    dist: [0.1, -0.2, 0, 0, 0.05],
    rms_px: 0.4,
  },
  updatedAt: 1700000000000,
};

describe('the settings schema', () => {
  test('says nothing about the person in front of the mirror', () => {
    const keys = manifest.settings.groups.flatMap((group) =>
      group.fields.map((field) => field.key),
    );
    expect(keys).toEqual([
      'projection.mode',
      'projection.mirror',
      'sleep.enabled',
      'sleep.wakeConfidence',
      'sleep.sleepConfidence',
      'sleep.sleepDelaySec',
      'sleep.maxDistanceM',
    ]);
  });
});

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

  test('falls back per field on invalid values, and ignores settings that are gone', () => {
    const merged = mergeConfig(DEFAULT_CONFIG, {
      projection: { mode: 'sideways', mirror: 'yes' },
      viewer: { ipdMm: 70, eye: 'left' },
      calibration: { method: 'fingertip' },
      sleep: { enabled: 1, wakeConfidence: Number.NaN, sleepDelaySec: '7' },
    });
    expect(merged).toEqual(DEFAULT_CONFIG);
  });
});

describe('toMirrorDriverConfig', () => {
  test('clears the rig when no profile is saved', () => {
    expect(toMirrorDriverConfig(DEFAULT_CONFIG, null)).toEqual({
      mode: 'direct',
      mirror: true,
      // Letterboxing the camera instead would leave the top and bottom of the
      // display outside the tracked band, out of reach of any hand.
      fit: 'cover',
      width: 1080,
      height: 1920,
      ipd_mm: DRIVER_IPD_MM,
      rig: null,
    });
  });

  test('applies the rig with its trim and the saved lens', () => {
    const update = toMirrorDriverConfig(DEFAULT_CONFIG, RIG, LENS);
    expect(update).toMatchObject({ rig: RIG.rig, trim_px: [4, -3], lens: LENS.lens });
    // The camera height travels inside the rig, where the driver reads it.
    expect(update.rig?.camera_height_mm).toBe(1720);
  });

  test('sends a null lens for a rig calibrated without one', () => {
    expect(toMirrorDriverConfig(DEFAULT_CONFIG, RIG).lens).toBeNull();
  });

  test('always sends the assumed pupil distance, so a preview cannot leak', () => {
    for (const profile of [null, RIG]) {
      expect(toMirrorDriverConfig(DEFAULT_CONFIG, profile).ipd_mm).toBe(DRIVER_IPD_MM);
    }
    expect(DRIVER_IPD_MM).toBe(63);
  });
});

describe('parseMirrorProfile', () => {
  test('reads a profile back, with its optional holdout figures', () => {
    const stored: MirrorProfile = {
      ...RIG,
      fit: { ...RIG.fit, holdout_mean_mm: 6.2, holdout_max_mm: 11 },
    };
    expect(parseMirrorProfile(JSON.parse(JSON.stringify(stored)))).toEqual(stored);
  });

  test('reads a rig calibrated before the camera height was asked for', () => {
    const { camera_height_mm: _rig, ...rig } = RIG.rig;
    const { camera_height_mm: _measured, ...measurements } = RIG.measurements;
    const parsed = parseMirrorProfile({ ...RIG, rig, measurements });
    expect(parsed?.rig.camera_height_mm).toBeNull();
    expect(parsed?.measurements.camera_height_mm).toBeUndefined();
  });

  test('reads a rig fitted before the iris was measured as the generic one', () => {
    const { iris_mm: _iris, ...rig } = RIG.rig;
    // What the driver assumed for those profiles all along.
    expect(parseMirrorProfile({ ...RIG, rig })?.rig.iris_mm).toBe(GENERIC_IRIS_MM);
    expect(GENERIC_IRIS_MM).toBe(11.7);
    // A measured one rides into the driver inside the rig, like the camera height.
    expect(parseMirrorProfile(RIG)?.rig.iris_mm).toBe(12.32);
    expect(toMirrorDriverConfig(DEFAULT_CONFIG, RIG).rig?.iris_mm).toBe(12.32);
  });

  test('refuses anything that is not the fitted rig', () => {
    // What the fingertip calibration used to save reads as no calibration at
    // all, which is what it is now.
    expect(parseMirrorProfile({ tilt_deg: 9, scale: 1.2, affine: [1, 2, 3, 4] })).toBeNull();
    expect(parseMirrorProfile({ ...RIG, version: 1 })).toBeNull();
    expect(parseMirrorProfile(null)).toBeNull();
    expect(parseMirrorProfile('profile')).toBeNull();
  });

  test('defaults a missing trim to none and clamps a stored one', () => {
    const withTrim = (trim_px: unknown): MirrorProfile | null =>
      parseMirrorProfile({ ...RIG, trim_px });
    expect(withTrim(undefined)).toMatchObject({ trim_px: [0, 0] });
    expect(withTrim([12, -9])).toMatchObject({ trim_px: [12, -9] });
    expect(withTrim([9000, -9000])).toMatchObject({ trim_px: [60, -60] });
    // A trim that is not a pair of numbers is corruption, not a nudge.
    expect(withTrim([1])).toBeNull();
    expect(withTrim(['left', 2])).toBeNull();
  });

  test('rejects anything that would make the rig path guess', () => {
    const broken: readonly Record<string, unknown>[] = [
      { ...RIG, rig: { ...RIG.rig, rotation: [0, 0] } },
      { ...RIG, rig: { ...RIG.rig, center_mm: [0, 0, Number.NaN] } },
      { ...RIG, rig: { ...RIG.rig, width_mm: 0 } },
      { ...RIG, rig: { ...RIG.rig, height_mm: -698 } },
      { ...RIG, rig: { ...RIG.rig, gap_mm: -1 } },
      { ...RIG, rig: { ...RIG.rig, camera_height_mm: 0 } },
      { ...RIG, rig: { ...RIG.rig, iris_mm: 8.9 } },
      { ...RIG, rig: { ...RIG.rig, iris_mm: 15.1 } },
      { ...RIG, rig: { ...RIG.rig, iris_mm: Number.NaN } },
      { ...RIG, rig: { ...RIG.rig, iris_mm: '11.7' } },
      { ...RIG, rig: undefined },
      { ...RIG, measurements: { ...RIG.measurements, screen_width_mm: 0 } },
      { ...RIG, measurements: { ...RIG.measurements, camera_height_mm: 'high' } },
      { ...RIG, measurements: undefined },
      { ...RIG, fit: { ...RIG.fit, quality: 'excellent' } },
      { ...RIG, fit: { ...RIG.fit, rms_mm: 'small' } },
      { ...RIG, fit: { ...RIG.fit, holdout_max_mm: 'big' } },
      { ...RIG, updatedAt: undefined },
    ];
    for (const value of broken) expect(parseMirrorProfile(value)).toBeNull();
  });
});

describe('parseStoredLens', () => {
  test('reads the saved intrinsics back', () => {
    expect(parseStoredLens(JSON.parse(JSON.stringify(LENS)))).toEqual(LENS);
  });

  test('accepts a lens with no distortion and no reported error', () => {
    const plain = {
      lens: { width: 640, height: 480, fx: 500, fy: 500, cx: 320, cy: 240 },
      updatedAt: 1,
    };
    expect(parseStoredLens(plain)).toEqual({ lens: { ...plain.lens, dist: [] }, updatedAt: 1 });
    expect(parseStoredLens({ ...plain, lens: { ...plain.lens, rms_px: null } })).toEqual({
      lens: { ...plain.lens, dist: [] },
      updatedAt: 1,
    });
  });

  test('rejects intrinsics that cannot describe a camera', () => {
    for (const value of [
      null,
      {},
      { lens: LENS.lens },
      { ...LENS, lens: { ...LENS.lens, fx: 0 } },
      { ...LENS, lens: { ...LENS.lens, width: -1280 } },
      { ...LENS, lens: { ...LENS.lens, cx: 'middle' } },
      { ...LENS, lens: { ...LENS.lens, dist: [0.1, 'k2'] } },
      { ...LENS, updatedAt: 'yesterday' },
    ]) {
      expect(parseStoredLens(value)).toBeNull();
    }
  });
});
