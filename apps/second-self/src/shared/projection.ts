/**
 * The mirror projection the `pose_to_mirror` driver runs with: the projection
 * settings plus the saved calibration profile. The calibration wizard changes
 * the driver's fit while it runs; this is what it saves to, and what the
 * driver goes back to when the wizard is left early.
 */

import type { DriverTypes, ExperienceRuntimeContext } from '@gosai/sdk';
import { saveMirrorProfile } from './calibration.js';
import { toMirrorDriverConfig, type MirrorProfile, type SecondSelfConfig } from './config.js';

type MirrorSettings = DriverTypes.pose_to_mirror.MirrorSettings;

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
  ) {}

  get config(): SecondSelfConfig {
    return this.currentConfig;
  }

  get profile(): MirrorProfile | null {
    return this.savedProfile;
  }

  /**
   * Takes new settings, e.g. changed from the dashboard. Returns whether the
   * projection fields changed, in which case the caller should apply them.
   */
  configure(config: SecondSelfConfig): boolean {
    const before = this.currentConfig.projection;
    this.currentConfig = config;
    return before.mode !== config.projection.mode || before.mirror !== config.projection.mirror;
  }

  /** Pushes the saved projection to the driver. */
  async apply(): Promise<void> {
    this.baseline = await this.rt.drivers.execute(
      'pose_to_mirror',
      'set_mirror_config',
      toMirrorDriverConfig(this.currentConfig, this.savedProfile),
    );
  }

  /** Records the driver's current settings, before a calibration run changes them. */
  async snapshot(): Promise<void> {
    this.baseline = await this.rt.drivers.execute('pose_to_mirror', 'set_mirror_config');
  }

  /**
   * Puts the driver back on the saved projection, dropping a fit the wizard
   * applied but didn't save. Without a saved profile the fit from the
   * baseline comes back.
   */
  async restore(): Promise<void> {
    const update = toMirrorDriverConfig(this.currentConfig, this.savedProfile);
    const baseline = this.baseline;
    await this.rt.drivers.execute('pose_to_mirror', 'set_mirror_config', {
      ...update,
      ...(!this.savedProfile && baseline
        ? { tilt_deg: baseline.tilt_deg, scale: baseline.scale, affine: baseline.affine }
        : {}),
    });
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
