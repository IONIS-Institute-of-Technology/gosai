/**
 * The mirror projection the `pose_to_mirror` driver runs with: the projection
 * settings, the saved calibration profile and the saved camera intrinsics. The
 * calibration wizard changes the driver's fit while it runs; this is what it
 * saves to, and what the driver goes back to when the wizard is left early.
 */

import type { DriverTypes, ExperienceRuntimeContext } from '@gosai/sdk';
import { saveLensProfile, saveMirrorProfile } from './calibration.js';
import {
  toMirrorDriverConfig,
  type MirrorProfile,
  type SecondSelfConfig,
  type StoredLens,
} from './config.js';

type MirrorSettings = DriverTypes.pose_to_mirror.MirrorSettings;
type MirrorSettingsUpdate = DriverTypes.pose_to_mirror.MirrorSettingsUpdate;

export class Projection {
  /**
   * The driver's settings from before the wizard changed them: the snapshot
   * taken when it started, else the result of the last apply.
   */
  private baseline: MirrorSettings | null = null;

  constructor(
    private readonly rt: ExperienceRuntimeContext,
    private currentConfig: SecondSelfConfig,
    private savedProfile: MirrorProfile | null,
    private savedLens: StoredLens | null = null,
  ) {}

  get config(): SecondSelfConfig {
    return this.currentConfig;
  }

  get profile(): MirrorProfile | null {
    return this.savedProfile;
  }

  get lens(): StoredLens | null {
    return this.savedLens;
  }

  /**
   * Takes new settings, e.g. changed from the dashboard. Returns whether the
   * fields the driver is given changed, in which case the caller should apply
   * them.
   */
  configure(config: SecondSelfConfig): boolean {
    const before = this.currentConfig;
    this.currentConfig = config;
    return (
      before.projection.mode !== config.projection.mode ||
      before.projection.mirror !== config.projection.mirror
    );
  }

  /** Pushes the saved projection to the driver. */
  async apply(): Promise<void> {
    this.baseline = await this.rt.drivers.execute(
      'pose_to_mirror',
      'set_mirror_config',
      toMirrorDriverConfig(this.currentConfig, this.savedProfile, this.savedLens),
    );
  }

  /** Records the driver's current settings, before a calibration run changes them. */
  async snapshot(): Promise<void> {
    this.baseline = await this.rt.drivers.execute('pose_to_mirror', 'set_mirror_config');
  }

  /**
   * Pushes settings the wizard is trying out, without saving them: a freshly
   * fitted rig or lens, a trim being nudged, the operator's own pupil distance
   * while they check the fit. The next {@link restore} or {@link apply} undoes
   * whatever this changed, `ipd_mm` included.
   */
  async preview(update: MirrorSettingsUpdate): Promise<void> {
    await this.rt.drivers.execute('pose_to_mirror', 'set_mirror_config', update);
  }

  /**
   * Puts the driver back on the saved projection, dropping a fit the wizard
   * applied but didn't save. Without a saved profile the rig the driver held
   * when the wizard started comes back.
   */
  async restore(): Promise<void> {
    const update = toMirrorDriverConfig(this.currentConfig, this.savedProfile, this.savedLens);
    const baseline = this.baseline;
    await this.rt.drivers.execute('pose_to_mirror', 'set_mirror_config', {
      ...update,
      ...(!this.savedProfile && baseline ? baselineCalibration(baseline) : {}),
    });
  }

  /**
   * Saves the camera intrinsics, which are kept apart from the mirror profile
   * and reused by later calibration runs. Aborting `signal` skips the save;
   * returns whether it ran.
   */
  async saveLens(stored: StoredLens, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return false;
    await saveLensProfile(this.rt, stored);
    this.savedLens = stored;
    return true;
  }

  /**
   * Saves a calibration profile and switches the app to reflection mode, which
   * is what calibrating on a mirror implies, then applies both. Aborting
   * `signal` skips the steps that haven't started yet; returns whether every
   * step ran.
   */
  async saveCalibration(profile: MirrorProfile, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return false;
    await saveMirrorProfile(this.rt, profile);
    this.savedProfile = profile;
    if (this.currentConfig.projection.mode !== 'reflection') {
      if (signal?.aborted) return false;
      await this.rt.settings.set({ 'projection.mode': 'reflection' });
      this.configure({
        ...this.currentConfig,
        projection: { ...this.currentConfig.projection, mode: 'reflection' },
      });
    }
    if (signal?.aborted) return false;
    await this.apply();
    return true;
  }
}

/**
 * The calibration the driver held before the wizard started, as an update that
 * puts it back. Without a rig there is nothing to keep, so the rig is cleared
 * rather than left on whatever the wizard fitted.
 */
function baselineCalibration(baseline: MirrorSettings): MirrorSettingsUpdate {
  if (!baseline.rig) return { rig: null };
  return { rig: baseline.rig, lens: baseline.lens, trim_px: [...baseline.trim_px] };
}
