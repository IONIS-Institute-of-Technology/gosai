import { describe, expect, test } from 'bun:test';
import { readCalibrationLaunch } from '@gosai/sdk';
import manifest from '../gosai.app.json';
import {
  CALIBRATION_CANCELLED,
  LENS_PROFILE_KEY,
  endCalibration,
  loadLensProfile,
  loadMirrorProfile,
  saveLensProfile,
} from '../src/shared/calibration.js';
import type { MirrorProfile, StoredLens } from '../src/shared/config.js';
import { FakeRuntime } from './fakes.js';

const RIG_PROFILE: MirrorProfile = {
  version: 2,
  rig: {
    rotation: [0, 0.1, 0],
    center_mm: [0, -40, 1200],
    width_mm: 392.85,
    height_mm: 698.4,
    gap_mm: 6,
    camera_height_mm: 1700,
    iris_mm: 12.32,
  },
  trim_px: [0, 0],
  measurements: {
    screen_width_mm: 392.85,
    screen_height_mm: 698.4,
    gap_mm: 6,
    camera_height_mm: 1700,
  },
  fit: { rms_mm: 2.5, predicted_error_mm: 4, quality: 'fair', samples: 8 },
  updatedAt: 7,
};

/** What the fingertip calibration used to save. */
const OLD_FORMAT = { tilt_deg: 9, scale: 1.2, affine: [1, 2, 3, 4], updatedAt: 7 };

const LENS: StoredLens = {
  lens: { width: 1280, height: 720, fx: 900, fy: 900, cx: 640, cy: 360, dist: [], rms_px: 0.3 },
  updatedAt: 3,
};

describe('the manifest', () => {
  test('declares the mirror calibration as an exclusive experience of the app', () => {
    expect(manifest.calibration).toEqual({ kind: 'mirror-reflection', experience: 'calibrate' });
    const experience = manifest.experiences.find((e) => e.slug === 'calibrate');
    expect(experience).toMatchObject({ entry: 'dist/calibrate.js', exclusive: true });
  });

  test('keeps the drivers the calibration needs running', () => {
    const experience = manifest.experiences.find((e) => e.slug === 'calibrate');
    expect(experience?.drivers).toEqual(['pose', 'pose_to_mirror', 'camera', 'mirror_calibration']);
  });
});

describe('loadMirrorProfile', () => {
  test('reads the calibration profile', async () => {
    const fake = new FakeRuntime();
    fake.profile = { version: 1, savedAt: 1, kind: 'mirror-reflection', data: RIG_PROFILE };
    expect(await loadMirrorProfile(fake.rt)).toEqual(RIG_PROFILE);
    expect(fake.warnings).toEqual([]);
  });

  test('ignores a profile from an older calibration, with one warning', async () => {
    const fake = new FakeRuntime();
    fake.profile = { version: 1, savedAt: 1, kind: 'mirror-reflection', data: OLD_FORMAT };
    expect(await loadMirrorProfile(fake.rt)).toBeNull();
    expect(fake.warnings).toHaveLength(1);
    // Nothing is rewritten: the mirror simply counts as uncalibrated.
    expect(fake.profile.data).toEqual(OLD_FORMAT);
  });

  test('returns null without a profile, and says nothing about it', async () => {
    const fake = new FakeRuntime();
    expect(await loadMirrorProfile(fake.rt)).toBeNull();
    expect(fake.warnings).toEqual([]);
  });

  test('returns null for a profile that would make the rig path guess', async () => {
    const fake = new FakeRuntime();
    fake.profile = {
      version: 1,
      savedAt: 1,
      kind: 'mirror-reflection',
      data: { ...RIG_PROFILE, rig: { ...RIG_PROFILE.rig, width_mm: 0 } },
    };
    expect(await loadMirrorProfile(fake.rt)).toBeNull();
  });
});

describe('the lens profile', () => {
  test("is saved under the app's own storage key and read back", async () => {
    const fake = new FakeRuntime();
    await saveLensProfile(fake.rt, LENS);
    expect(fake.storage.get(LENS_PROFILE_KEY)).toEqual(LENS);
    expect(await loadLensProfile(fake.rt)).toEqual(LENS);
    // It belongs to the camera, not to the mirror: no calibration profile is written.
    expect(fake.profile).toBeNull();
  });

  test('is simply absent before the lens is calibrated', async () => {
    const fake = new FakeRuntime();
    expect(await loadLensProfile(fake.rt)).toBeNull();
    expect(fake.warnings).toEqual([]);
  });

  test('is ignored with a warning when what was saved no longer parses', async () => {
    const fake = new FakeRuntime();
    fake.storage.set(LENS_PROFILE_KEY, { lens: { width: 1280 }, updatedAt: 3 });
    expect(await loadLensProfile(fake.rt)).toBeNull();
    expect(fake.warnings).toHaveLength(1);
  });
});

describe('leaving the calibration', () => {
  test("GOSAI's flow gets the result and nothing switches", async () => {
    const windows: Record<string, string>[] = [
      { role: 'control', target: 'second-self' },
      { target: 'second-self' },
    ];
    for (const params of windows) {
      const fake = new FakeRuntime({ params });
      await endCalibration(fake.rt, readCalibrationLaunch(fake.rt), CALIBRATION_CANCELLED);
      expect(fake.emitted).toEqual([{ topic: 'wizard:finished', data: CALIBRATION_CANCELLED }]);
      expect(fake.switched).toEqual([]);
      // Nothing is remembered about the run: main never opens this by itself.
      expect(fake.storage.size).toBe(0);
    }
  });

  test('a run nobody is waiting for goes back to main', async () => {
    const fake = new FakeRuntime();
    await endCalibration(fake.rt, readCalibrationLaunch(fake.rt), CALIBRATION_CANCELLED);
    expect(fake.switched).toEqual(['main']);
    expect(fake.emitted).toEqual([]);
    expect(fake.storage.size).toBe(0);
  });
});
