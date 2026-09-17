import { describe, expect, test } from 'bun:test';
import {
  CALIBRATION_RUNNER,
  calibrationFlow,
  isBuiltinCalibrationKind,
  isCalibrated,
  upgradeLegacyCalibration,
} from '../src/calibration.js';
import { parseCalibrationData } from '../src/schemas.js';

describe('calibration contract', () => {
  const surface = { kind: 'camera-projector-surface', required: true };

  test('"calibrated" means a current profile of the declared kind', () => {
    const profile = { version: 1, kind: 'camera-projector-surface' } as const;
    expect(isCalibrated(surface, profile)).toBe(true);
    expect(isCalibrated(surface, null)).toBe(false);
    expect(isCalibrated(undefined, profile)).toBe(false);
    expect(isCalibrated({ kind: 'acme-depth' }, profile)).toBe(false);
    expect(isCalibrated(surface, { ...profile, version: 2 as 1 })).toBe(false);
  });

  test('built-in kinds run in the calibration app, custom flows in their own experience', () => {
    expect(isBuiltinCalibrationKind('camera-projector-surface')).toBe(true);
    expect(isBuiltinCalibrationKind('acme-depth')).toBe(false);
    expect(calibrationFlow('pool', surface)).toEqual(CALIBRATION_RUNNER);
    expect(
      calibrationFlow('depth', { kind: 'acme-depth', required: false, experience: 'setup' }),
    ).toEqual({ appSlug: 'depth', experienceSlug: 'setup' });
  });

  test('profile data is checked for built-in kinds only', () => {
    expect(parseCalibrationData('camera-projector-surface', { homography: [] })).toMatchObject({
      success: false,
    });
    expect(parseCalibrationData('acme-depth', { anything: true })).toEqual({
      success: true,
      data: { anything: true },
    });
    expect(parseCalibrationData('acme-depth', undefined).success).toBe(false);
  });

  test('only shapes from before kinds are upgraded', () => {
    const current = { kind: 'acme-depth', experience: 'setup' };
    expect(upgradeLegacyCalibration(current)).toEqual({ calibration: current, warnings: [] });
    expect(upgradeLegacyCalibration('nope')).toEqual({ calibration: 'nope', warnings: [] });
    expect(upgradeLegacyCalibration({ required: true, entry: 'a.js' }).calibration).toEqual({
      kind: 'camera-projector-surface',
      required: true,
    });
  });
});
