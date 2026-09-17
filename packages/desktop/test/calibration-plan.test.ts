import { describe, expect, test } from 'bun:test';
import { planKioskCalibration, usesCalibrationRunner } from '../src/main/calibration-plan.js';
import { readyToStart } from '../src/renderer/src/lib/calibration-gate.js';

const REQUIRED = { kind: 'camera-projector-surface', required: true };
const OPTIONAL = { kind: 'camera-projector-surface' };
const CUSTOM = { kind: 'acme-depth', required: true, experience: 'setup' };

describe('kiosk calibration plan', () => {
  const plan = async (
    calibration: unknown,
    force: boolean,
    calibrated: boolean,
  ): Promise<{ plan: string; asked: boolean }> => {
    let asked = false;
    const result = await planKioskCalibration(calibration, {
      force,
      isCalibrated: async () => {
        asked = true;
        return calibrated;
      },
    });
    return { plan: result, asked };
  };

  test('a required app runs the flow on first boot only', async () => {
    expect(await plan(REQUIRED, false, false)).toEqual({ plan: 'run', asked: true });
    expect(await plan(REQUIRED, false, true)).toEqual({ plan: 'skip', asked: true });
  });

  test('an optional app starts right away unless calibration is forced', async () => {
    expect(await plan(OPTIONAL, false, false)).toEqual({ plan: 'skip', asked: false });
    expect(await plan(OPTIONAL, true, true)).toEqual({ plan: 'run', asked: false });
  });

  test('forcing runs even an already calibrated app, and reports apps without calibration', async () => {
    expect(await plan(REQUIRED, true, true)).toEqual({ plan: 'run', asked: false });
    expect(await plan(undefined, true, false)).toEqual({ plan: 'undeclared', asked: false });
    expect(await plan(undefined, false, false)).toEqual({ plan: 'skip', asked: false });
  });

  test('a custom flow is planned the same way but needs no runner app', async () => {
    expect(await plan(CUSTOM, false, false)).toEqual({ plan: 'run', asked: true });
    expect(usesCalibrationRunner(CUSTOM)).toBe(false);
    expect(usesCalibrationRunner(REQUIRED)).toBe(true);
    expect(usesCalibrationRunner(undefined)).toBe(false);
  });

  test('manifests in the pre-kind shape are read as the server reads them', async () => {
    const entry = { required: true, entry: 'dist/calibration.js' };
    expect(await plan(entry, false, false)).toEqual({ plan: 'run', asked: true });
    expect(usesCalibrationRunner(entry)).toBe(true);
    // Without an entry it never did anything, and is ignored.
    expect(await plan({ required: false }, true, false)).toEqual({
      plan: 'undeclared',
      asked: false,
    });
    expect(usesCalibrationRunner({ required: false })).toBe(false);
  });
});

describe('dashboard start gate', () => {
  const gate = async (
    required: boolean,
    calibrated: boolean,
    calibrationSaves: boolean,
  ): Promise<{ ready: boolean; runs: number }> => {
    let runs = 0;
    const ready = await readyToStart({
      required,
      isCalibrated: async () => calibrated,
      calibrate: async () => {
        runs += 1;
        return calibrationSaves;
      },
    });
    return { ready, runs };
  };

  test('an app that requires calibration is calibrated before it starts', async () => {
    expect(await gate(true, false, true)).toEqual({ ready: true, runs: 1 });
    // A cancelled or failed calibration keeps it from starting.
    expect(await gate(true, false, false)).toEqual({ ready: false, runs: 1 });
  });

  test('calibrated and optional apps start directly', async () => {
    expect(await gate(true, true, false)).toEqual({ ready: true, runs: 0 });
    expect(await gate(false, false, false)).toEqual({ ready: true, runs: 0 });
  });
});
