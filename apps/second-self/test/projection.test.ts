import { describe, expect, test } from 'bun:test';
import { DEFAULT_CONFIG, mergeConfig, type MirrorProfile } from '../src/shared/config.js';
import { MenuOptions } from '../src/shared/layers.js';
import { Projection } from '../src/shared/projection.js';
import { FakeRuntime, type FakeRuntimeOptions } from './fakes.js';

const DRIVER_SETTINGS = { mode: 'direct', tilt_deg: 17, scale: 1, affine: null, face_mesh: true };

function fakeRuntime(options: FakeRuntimeOptions = {}): FakeRuntime {
  return new FakeRuntime({ driver: { ...DRIVER_SETTINGS }, ...options });
}

const PROFILE: MirrorProfile = { tilt_deg: 9, scale: 1.2, affine: [1, 2, 3, 4] };

describe('Projection', () => {
  test('restore drops an unsaved fit and brings back the earlier tilt and scale', async () => {
    const { rt, executed } = fakeRuntime();
    const projection = new Projection(rt, DEFAULT_CONFIG, null);
    await projection.apply();
    // The wizard's solve changes the driver's fit behind the projection's back.
    await projection.restore();
    expect(executed.at(-1)).toEqual({
      driver: 'pose_to_mirror',
      action: 'set_mirror_config',
      params: {
        mode: 'direct',
        mirror: true,
        width: 1080,
        height: 1920,
        tilt_deg: 17,
        scale: 1,
        affine: null,
      },
    });
  });

  test('restore without a profile uses the snapshot taken when the wizard started', async () => {
    // The startup apply never completed, but the driver holds a fit.
    const driver = { ...DRIVER_SETTINGS, tilt_deg: 12, scale: 1.3, affine: [5, 6, 7, 8] };
    const { rt, executed } = fakeRuntime({ driver });
    const projection = new Projection(rt, DEFAULT_CONFIG, null);
    await projection.snapshot();
    expect(executed.at(-1)).toEqual({
      driver: 'pose_to_mirror',
      action: 'set_mirror_config',
      params: undefined,
    });
    // The wizard's solve replaces the fit.
    Object.assign(driver, { tilt_deg: 30, scale: 2, affine: [0, 0, 0, 0] });
    await projection.restore();
    expect(executed.at(-1)?.params).toMatchObject({
      tilt_deg: 12,
      scale: 1.3,
      affine: [5, 6, 7, 8],
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
  });

  test('restore puts the saved profile back', async () => {
    const { rt, executed } = fakeRuntime();
    const reflection = mergeConfig(DEFAULT_CONFIG, { projection: { mode: 'reflection' } });
    await new Projection(rt, reflection, PROFILE).restore();
    expect(executed.at(-1)?.params).toMatchObject({
      mode: 'reflection',
      tilt_deg: 9,
      scale: 1.2,
      affine: [1, 2, 3, 4],
    });
  });

  test('saving a calibration stores it, switches to reflection and applies it', async () => {
    const fake = fakeRuntime();
    const { rt, executed, settings } = fake;
    const projection = new Projection(rt, DEFAULT_CONFIG, null);
    await projection.saveCalibration(PROFILE);
    expect(fake.profile).toMatchObject({ kind: 'mirror-reflection', data: PROFILE });
    expect(settings).toEqual([{ 'projection.mode': 'reflection' }]);
    expect(projection.config.projection.mode).toBe('reflection');
    expect(DEFAULT_CONFIG.projection.mode).toBe('direct');
    expect(executed.at(-1)?.params).toMatchObject({ mode: 'reflection', tilt_deg: 9 });

    // Already in reflection mode: only the profile changes.
    await projection.saveCalibration({ ...PROFILE, scale: 2 });
    expect(settings).toHaveLength(1);
  });

  test('an aborted save skips the steps that had not started', async () => {
    const controller = new AbortController();
    const fake = fakeRuntime();
    const { rt, executed, settings } = fake;
    const projection = new Projection(rt, DEFAULT_CONFIG, null);
    const saving = projection.saveCalibration(PROFILE, controller.signal);
    // Leaving while the profile saves.
    controller.abort();
    expect(await saving).toBe(false);
    expect(fake.profile?.data).toEqual(PROFILE);
    expect(settings).toEqual([]);
    expect(executed).toEqual([]);
    expect(projection.config.projection.mode).toBe('direct');

    const aborted = new AbortController();
    aborted.abort();
    const fresh = fakeRuntime();
    expect(
      await new Projection(fresh.rt, DEFAULT_CONFIG, null).saveCalibration(PROFILE, aborted.signal),
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
