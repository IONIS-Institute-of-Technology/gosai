/**
 * The mirror projection the `pose_to_mirror` driver runs with: the projection
 * settings plus the saved calibration profile. The calibration wizard changes
 * the driver's fit while it runs; this is what it saves to, and what the
 * driver goes back to when the wizard is left early.
 */

import type { DriverTypes, ExperienceRuntimeContext } from '@gosai/sdk';
import {
  MIRROR_PROFILE_STORAGE_KEY,
  toMirrorDriverConfig,
  type MirrorProfile,
  type SecondSelfConfig,
} from './config.js';

type MirrorSettings = DriverTypes.pose_to_mirror.MirrorSettings;

export class Projection {
  /** Driver settings after the last apply, the fallback fit when no profile is saved. */
  private applied: MirrorSettings | null = null;

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

  /** Pushes the saved projection to the driver. */
  async apply(): Promise<void> {
    this.applied = await this.rt.drivers.execute(
      'pose_to_mirror',
      'set_mirror_config',
      toMirrorDriverConfig(this.currentConfig, this.savedProfile),
    );
  }

  /**
   * Puts the driver back on the saved projection, dropping a fit the wizard
   * applied but didn't save. Without a saved profile the tilt and scale the
   * driver had before go back too.
   */
  async restore(): Promise<void> {
    const update = toMirrorDriverConfig(this.currentConfig, this.savedProfile);
    const previous = this.applied;
    await this.rt.drivers.execute('pose_to_mirror', 'set_mirror_config', {
      ...update,
      ...(!this.savedProfile && previous
        ? { tilt_deg: previous.tilt_deg, scale: previous.scale, affine: previous.affine }
        : {}),
    });
  }

  /**
   * Saves a calibration profile and switches the app to reflection mode, which
   * is what calibrating on a mirror implies, then applies both.
   */
  async saveCalibration(profile: MirrorProfile): Promise<void> {
    await this.rt.storage.set(MIRROR_PROFILE_STORAGE_KEY, profile);
    this.savedProfile = profile;
    if (this.currentConfig.projection.mode !== 'reflection') {
      await this.rt.settings.set({ 'projection.mode': 'reflection' });
      this.currentConfig = {
        ...this.currentConfig,
        projection: { ...this.currentConfig.projection, mode: 'reflection' },
      };
    }
    await this.apply();
  }
}
