import { describe, expect, test } from 'bun:test';
import { LENS_PROFILE_KEY } from '../src/shared/calibration.js';
import {
  DEFAULT_CONFIG,
  DRIVER_IPD_MM,
  mergeConfig,
  type MirrorProfile,
  type StoredLens,
} from '../src/shared/config.js';
import { MenuOptions } from '../src/shared/layers.js';
import { Projection } from '../src/shared/projection.js';
import { FakeRuntime, type FakeRuntimeOptions } from './fakes.js';

/** The driver's defaults, as `set_mirror_config` reports them back. */
const DRIVER_SETTINGS = {
  mode: 'direct',
  face_mesh: true,
  rig: null,
  lens: null,
  trim_px: [0, 0],
  ipd_mm: DRIVER_IPD_MM,
};

function fakeRuntime(options: FakeRuntimeOptions = {}): FakeRuntime {
  return new FakeRuntime({ driver: { ...DRIVER_SETTINGS }, ...options });
}

const RIG_PROFILE: MirrorProfile = {
  version: 2,
  rig: {
    rotation: [0, 0.1, 0],
    center_mm: [0, -40, 1200],
    width_mm: 392.85,
    height_mm: 698.4,
    gap_mm: 6,
    camera_height_mm: 1700,
  },
  trim_px: [2, -2],
  measurements: { screen_width_mm: 392.85, screen_height_mm: 698.4, gap_mm: 6 },
  fit: { rms_mm: 2.5, predicted_error_mm: 4, quality: 'good', samples: 8 },
  updatedAt: 5,
};

const LENS: StoredLens = {
  lens: { width: 1280, height: 720, fx: 900, fy: 900, cx: 640, cy: 360, dist: [], rms_px: 0.3 },
  updatedAt: 3,
};

const REFLECTION = mergeConfig(DEFAULT_CONFIG, { projection: { mode: 'reflection' } });

describe('Projection', () => {
  test('restore drops an unsaved fit when there was nothing to go back to', async () => {
    const { rt, executed } = fakeRuntime();
    const projection = new Projection(rt, DEFAULT_CONFIG, null);
    await projection.apply();
    // The wizard's solve changes the driver's rig behind the projection's back.
    await projection.restore();
    expect(executed.at(-1)).toEqual({
      driver: 'pose_to_mirror',
      action: 'set_mirror_config',
      params: {
        mode: 'direct',
        mirror: true,
        fit: 'cover',
        width: 1080,
        height: 1920,
        ipd_mm: DRIVER_IPD_MM,
        rig: null,
      },
    });
  });

  test('restore without a profile brings back the rig the baseline was on', async () => {
    const driver = {
      ...DRIVER_SETTINGS,
      rig: RIG_PROFILE.rig,
      lens: LENS.lens,
      trim_px: [7, 8],
    };
    const { rt, executed } = fakeRuntime({ driver });
    const projection = new Projection(rt, REFLECTION, null);
    await projection.snapshot();
    expect(executed.at(-1)).toEqual({
      driver: 'pose_to_mirror',
      action: 'set_mirror_config',
      params: undefined,
    });
    // The wizard fits another rig, nudges the trim and previews its own pupils.
    Object.assign(driver, {
      rig: { ...RIG_PROFILE.rig, gap_mm: 99 },
      trim_px: [0, 0],
      ipd_mm: 71,
    });
    await projection.restore();
    expect(executed.at(-1)?.params).toMatchObject({
      rig: RIG_PROFILE.rig,
      lens: LENS.lens,
      trim_px: [7, 8],
      ipd_mm: DRIVER_IPD_MM,
    });
  });

  test('configure reports projection changes only', () => {
    const { rt } = fakeRuntime();
    const projection = new Projection(rt, DEFAULT_CONFIG, null);
    const sleepier = mergeConfig(DEFAULT_CONFIG, { sleep: { sleepDelaySec: 30 } });
    expect(projection.configure(sleepier)).toBe(false);
    expect(projection.configure(mergeConfig(sleepier, { projection: { mirror: false } }))).toBe(
      true,
    );
    expect(projection.config.projection.mirror).toBe(false);
    expect(
      projection.configure(mergeConfig(sleepier, { projection: { mode: 'reflection' } })),
    ).toBe(true);
  });

  test('restore puts the saved rig, its lens and the assumed pupil distance back', async () => {
    const { rt, executed } = fakeRuntime();
    const projection = new Projection(rt, REFLECTION, RIG_PROFILE, LENS);
    await projection.apply();
    // The verify screen previews the operator's own eyes and a trim.
    await projection.preview({ trim_px: [40, 40], ipd_mm: 71 });
    await projection.restore();
    expect(executed.at(-1)?.params).toMatchObject({
      mode: 'reflection',
      rig: RIG_PROFILE.rig,
      trim_px: [2, -2],
      lens: LENS.lens,
      ipd_mm: DRIVER_IPD_MM,
    });
  });

  test('preview pushes unsaved wizard state and nothing else', async () => {
    const { rt, executed } = fakeRuntime();
    const projection = new Projection(rt, REFLECTION, null);
    await projection.preview({ rig: RIG_PROFILE.rig, trim_px: [3, 4] });
    expect(executed).toEqual([
      {
        driver: 'pose_to_mirror',
        action: 'set_mirror_config',
        params: { rig: RIG_PROFILE.rig, trim_px: [3, 4] },
      },
    ]);
    expect(projection.profile).toBeNull();
  });

  test('saveLens stores the intrinsics apart from the mirror profile', async () => {
    const fake = fakeRuntime();
    const projection = new Projection(fake.rt, REFLECTION, RIG_PROFILE);
    expect(await projection.saveLens(LENS)).toBe(true);
    expect(fake.storage.get(LENS_PROFILE_KEY)).toEqual(LENS);
    expect(fake.profile).toBeNull();
    expect(projection.lens).toEqual(LENS);
    // The next apply carries it to the driver.
    await projection.apply();
    expect(fake.executed.at(-1)?.params).toMatchObject({ lens: LENS.lens });

    const aborted = AbortSignal.abort();
    const fresh = fakeRuntime();
    expect(await new Projection(fresh.rt, REFLECTION, null).saveLens(LENS, aborted)).toBe(false);
    expect(fresh.storage.has(LENS_PROFILE_KEY)).toBe(false);
  });

  test('saving a calibration stores it, switches to reflection and applies it', async () => {
    const fake = fakeRuntime();
    const { rt, executed, settings } = fake;
    const projection = new Projection(rt, DEFAULT_CONFIG, null, LENS);
    expect(await projection.saveCalibration(RIG_PROFILE)).toBe(true);
    expect(fake.profile).toMatchObject({ kind: 'mirror-reflection', data: RIG_PROFILE });
    expect(settings).toEqual([{ 'projection.mode': 'reflection' }]);
    expect(projection.config.projection.mode).toBe('reflection');
    expect(DEFAULT_CONFIG.projection.mode).toBe('direct');
    expect(executed.at(-1)?.params).toMatchObject({
      mode: 'reflection',
      rig: RIG_PROFILE.rig,
      trim_px: [2, -2],
      lens: LENS.lens,
      // Whatever the verify screen previewed, what is saved draws for the public.
      ipd_mm: DRIVER_IPD_MM,
    });

    // Already in reflection mode: only the profile changes.
    await projection.saveCalibration({ ...RIG_PROFILE, trim_px: [0, 0] });
    expect(settings).toHaveLength(1);
  });

  test('an aborted save skips the steps that had not started', async () => {
    const controller = new AbortController();
    const fake = fakeRuntime();
    const { rt, executed, settings } = fake;
    const projection = new Projection(rt, DEFAULT_CONFIG, null);
    const saving = projection.saveCalibration(RIG_PROFILE, controller.signal);
    // Leaving while the profile saves.
    controller.abort();
    expect(await saving).toBe(false);
    expect(fake.profile?.data).toEqual(RIG_PROFILE);
    expect(settings).toEqual([]);
    expect(executed).toEqual([]);
    expect(projection.config.projection.mode).toBe('direct');

    const aborted = new AbortController();
    aborted.abort();
    const fresh = fakeRuntime();
    expect(
      await new Projection(fresh.rt, DEFAULT_CONFIG, null).saveCalibration(
        RIG_PROFILE,
        aborted.signal,
      ),
    ).toBe(false);
    expect(fresh.profile).toBeNull();
  });
});

describe('MenuOptions', () => {
  const layers = [
    {
      slug: 'music',
      options: [
        { name: 'Bars', type: 'toggle', default: true },
        { name: 'Play', type: 'button' },
      ],
    },
  ] as const;

  test('toggles start at their default', () => {
    const options = new MenuOptions(layers);
    expect(options.get('music', 'Bars')).toBe(true);
    options.toggle('music', 'Bars');
    expect(options.get('music', 'Bars')).toBe(false);
    expect(options.get('music', 'Play')).toBe(false);
  });

  test('buttons fire their listeners until unsubscribed, and errors are reported', () => {
    const errors: string[] = [];
    const options = new MenuOptions(layers, (slug) => void errors.push(slug));
    let fired = 0;
    const off = options.onTrigger('music', 'Play', () => void fired++);
    options.onTrigger('music', 'Play', () => {
      throw new Error('boom');
    });
    options.trigger('music', 'Play');
    off();
    options.trigger('music', 'Play');
    expect(fired).toBe(1);
    expect(errors).toEqual(['music', 'music']);
  });
});
