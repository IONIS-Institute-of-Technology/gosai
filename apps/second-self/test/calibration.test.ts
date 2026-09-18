import { describe, expect, test } from 'bun:test';
import { readCalibrationLaunch } from '@gosai/sdk';
import manifest from '../gosai.app.json';
import {
  CALIBRATION_CANCELLED,
  CALIBRATION_LEFT_KEY,
  LEGACY_PROFILE_KEY,
  endCalibration,
  loadMirrorProfile,
  openCalibration,
  shouldCalibrateFirst,
} from '../src/shared/calibration.js';
import { DEFAULT_CONFIG, mergeConfig, type MirrorProfile } from '../src/shared/config.js';
import { FakeRuntime } from './fakes.js';

const PROFILE: MirrorProfile = { tilt_deg: 9, scale: 1.2, affine: [1, 2, 3, 4], updatedAt: 7 };
const REFLECTION = mergeConfig(DEFAULT_CONFIG, { projection: { mode: 'reflection' } });

describe('the manifest', () => {
  test('declares the mirror calibration as an exclusive experience of the app', () => {
    expect(manifest.calibration).toEqual({ kind: 'mirror-reflection', experience: 'calibrate' });
    const experience = manifest.experiences.find((e) => e.slug === 'calibrate');
    expect(experience).toMatchObject({ entry: 'dist/calibrate.js', exclusive: true });
  });
});

describe('loadMirrorProfile', () => {
  test('reads the calibration profile', async () => {
    const fake = new FakeRuntime();
    fake.profile = { version: 1, savedAt: 1, kind: 'mirror-reflection', data: PROFILE };
    fake.storage.set(LEGACY_PROFILE_KEY, { ...PROFILE, scale: 5 });
    expect(await loadMirrorProfile(fake.rt)).toEqual(PROFILE);
    // A saved profile wins over the old key, which stays as it is.
    expect(fake.storage.has(LEGACY_PROFILE_KEY)).toBe(true);
  });

  test('converts the profile an older install kept under mirror_calibration', async () => {
    const fake = new FakeRuntime();
    fake.storage.set('mirror_calibration', PROFILE);
    expect(await loadMirrorProfile(fake.rt)).toEqual(PROFILE);
    expect(fake.profile).toMatchObject({ kind: 'mirror-reflection', data: PROFILE });
    expect(fake.storage.has('mirror_calibration')).toBe(false);
    // Converted once: the next read finds the profile.
    expect(await loadMirrorProfile(fake.rt)).toEqual(PROFILE);
  });

  test('keeps the old key when the conversion fails', async () => {
    const fake = new FakeRuntime({ failSave: true });
    fake.storage.set(LEGACY_PROFILE_KEY, PROFILE);
    expect(await loadMirrorProfile(fake.rt)).toEqual(PROFILE);
    expect(fake.storage.get(LEGACY_PROFILE_KEY)).toEqual(PROFILE);
    expect(fake.warnings).toHaveLength(1);
  });

  test('returns null without a valid profile', async () => {
    const fake = new FakeRuntime();
    expect(await loadMirrorProfile(fake.rt)).toBeNull();
    fake.storage.set(LEGACY_PROFILE_KEY, { tilt_deg: 9, scale: 1, affine: [1, 2] });
    expect(await loadMirrorProfile(fake.rt)).toBeNull();
    expect(fake.profile).toBeNull();
    fake.profile = { version: 1, savedAt: 1, kind: 'mirror-reflection', data: { scale: 1 } };
    expect(await loadMirrorProfile(fake.rt)).toBeNull();
  });
});

describe('entering and leaving the calibration', () => {
  test('the menu switches to the calibration experience', async () => {
    const fake = new FakeRuntime();
    openCalibration(fake.rt);
    await Promise.resolve();
    expect(fake.switched).toEqual(['calibrate']);
  });

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
      expect(fake.storage.get(CALIBRATION_LEFT_KEY)).toBe(true);
    }
    const saved = new FakeRuntime({ params: { target: 'second-self' } });
    await endCalibration(saved.rt, readCalibrationLaunch(saved.rt), { ok: true });
    expect(saved.emitted).toEqual([{ topic: 'wizard:finished', data: { ok: true } }]);
    expect(saved.storage.size).toBe(0);
  });

  test('a run the app started goes back to main', async () => {
    const saved = new FakeRuntime();
    await endCalibration(saved.rt, readCalibrationLaunch(saved.rt), { ok: true });
    expect(saved.switched).toEqual(['main']);
    expect(saved.emitted).toEqual([]);
    expect(saved.storage.size).toBe(0);

    const left = new FakeRuntime();
    await endCalibration(left.rt, readCalibrationLaunch(left.rt), CALIBRATION_CANCELLED);
    expect(left.switched).toEqual(['main']);
    expect(left.storage.get(CALIBRATION_LEFT_KEY)).toBe(true);
  });

  test('main calibrates first on a mirror rig without a profile', async () => {
    const fake = new FakeRuntime();
    expect(await shouldCalibrateFirst(fake.rt, REFLECTION, null)).toBe(true);
    expect(await shouldCalibrateFirst(fake.rt, REFLECTION, PROFILE)).toBe(false);
    expect(await shouldCalibrateFirst(fake.rt, DEFAULT_CONFIG, null)).toBe(false);
  });

  test('main does not send the user straight back after they left', async () => {
    const fake = new FakeRuntime();
    await endCalibration(fake.rt, readCalibrationLaunch(fake.rt), CALIBRATION_CANCELLED);
    expect(await shouldCalibrateFirst(fake.rt, REFLECTION, null)).toBe(false);
    expect(fake.storage.has(CALIBRATION_LEFT_KEY)).toBe(false);
    // Only once: the next start calibrates again.
    expect(await shouldCalibrateFirst(fake.rt, REFLECTION, null)).toBe(true);
  });
});
