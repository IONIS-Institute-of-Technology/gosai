/**
 * Calibration profiles: one versioned object per app, stored under
 * `calibration_profile` in the app's storage (see `@gosai/shared/calibration`).
 *
 * Before profiles, the camera-projector-surface flow wrote nine separate keys.
 * Reading an app that still has them converts them into a profile once, so
 * installs calibrated before the change stay calibrated.
 */

import {
  CALIBRATION_PROFILE_KEY,
  CALIBRATION_PROFILE_VERSION,
  CalibrationKinds,
  DEFAULT_SURFACE_SIZE,
  isCalibrated,
  type CalibrationProfile,
  type CalibrationProfileInput,
} from '@gosai/shared/calibration';
import {
  calibrationProfileSchema,
  formatZodError,
  parseCalibrationData,
} from '@gosai/shared/schemas';
import type { AppManifest } from '@gosai/shared';
import type { ChildLogger } from '../logger/logger.js';
import type { AppStorage, StoredValue } from './storage.js';

/** Keys the camera-projector-surface flow wrote before profiles existed. */
export const LEGACY_CALIBRATION_KEYS = {
  Status: 'calibration_status',
  Homography: 'calibration_homography',
  HomographyInverse: 'calibration_homography_inverse',
  HomographySurface: 'calibration_homography_surface',
  HomographySurfaceInverse: 'calibration_homography_surface_inverse',
  FocusQuad: 'calibration_focus_quad',
  SurfaceQuadDisplay: 'calibration_surface_quad_display',
  SurfaceSize: 'calibration_surface_size',
  FrameSize: 'calibration_frame_size',
  MarkersLayout: 'calibration_markers_layout',
} as const;

export interface CalibrationState {
  readonly profile: CalibrationProfile | null;
  readonly calibrated: boolean;
}

export interface CalibrationStoreOptions {
  readonly getManifest: (slug: string) => AppManifest | undefined;
  readonly storage: Pick<AppStorage, 'get' | 'set' | 'remove'>;
  readonly logger: Pick<ChildLogger, 'info' | 'warn'>;
  readonly now?: () => number;
}

export class CalibrationStore {
  constructor(private readonly options: CalibrationStoreOptions) {}

  get(appSlug: string): CalibrationState {
    const manifest = this.requireManifest(appSlug);
    const profile = this.readProfile(appSlug);
    return { profile, calibrated: isCalibrated(manifest.calibration, profile) };
  }

  /** Replaces the app's profile. Throws when the manifest declares another kind or the data is invalid. */
  save(appSlug: string, input: CalibrationProfileInput): CalibrationProfile {
    const manifest = this.requireManifest(appSlug);
    const declared = manifest.calibration;
    if (!declared) throw new Error(`${appSlug} does not declare calibration in its manifest`);
    if (input.kind !== declared.kind) {
      throw new Error(`${appSlug} calibrates as ${declared.kind}, not ${input.kind}`);
    }
    const data = parseCalibrationData(input.kind, input.data);
    if (!data.success) throw new Error(`Invalid ${input.kind} calibration: ${data.error}`);
    const profile: CalibrationProfile = {
      version: CALIBRATION_PROFILE_VERSION,
      kind: input.kind,
      savedAt: (this.options.now ?? Date.now)(),
      data: data.data,
    };
    this.options.storage.set(appSlug, CALIBRATION_PROFILE_KEY, profile);
    this.removeLegacyKeys(appSlug);
    this.options.logger.info('calibration saved', { app: appSlug, kind: profile.kind });
    return profile;
  }

  private requireManifest(appSlug: string): AppManifest {
    const manifest = this.options.getManifest(appSlug);
    if (!manifest) throw new Error(`App not installed: ${appSlug}`);
    return manifest;
  }

  /** The stored profile, a converted legacy one, or `null`. An unreadable profile counts as none. */
  private readProfile(appSlug: string): CalibrationProfile | null {
    let stored: StoredValue;
    try {
      stored = this.options.storage.get(appSlug, CALIBRATION_PROFILE_KEY);
    } catch (err) {
      // Corrupt JSON. Saving a new profile replaces the file.
      this.options.logger.warn('ignoring an unreadable calibration profile', {
        app: appSlug,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
    if (!stored.found) return this.migrateLegacy(appSlug);
    const parsed = calibrationProfileSchema.safeParse(stored.value);
    if (!parsed.success) {
      this.options.logger.warn('ignoring an unreadable calibration profile', {
        app: appSlug,
        error: formatZodError(parsed.error),
      });
      return null;
    }
    return parsed.data;
  }

  private migrateLegacy(appSlug: string): CalibrationProfile | null {
    const profile = readLegacyProfile((key) => {
      try {
        const stored = this.options.storage.get(appSlug, key);
        return stored.found ? stored.value : undefined;
      } catch {
        // A corrupt legacy key makes the whole legacy profile unusable.
        return undefined;
      }
    });
    if (!profile) return null;
    this.options.storage.set(appSlug, CALIBRATION_PROFILE_KEY, profile);
    this.removeLegacyKeys(appSlug);
    this.options.logger.info('converted legacy calibration keys into a profile', { app: appSlug });
    return profile;
  }

  private removeLegacyKeys(appSlug: string): void {
    for (const key of Object.values(LEGACY_CALIBRATION_KEYS)) {
      this.options.storage.remove(appSlug, key);
    }
  }
}

/**
 * Builds a camera-projector-surface profile from the legacy keys. The old
 * flow only counted as calibrated once it wrote `calibration_status`, so
 * without it, or without valid matrices, there is no profile.
 */
export function readLegacyProfile(read: (key: string) => unknown): CalibrationProfile | null {
  const status = read(LEGACY_CALIBRATION_KEYS.Status);
  if (status === undefined || status === null) return null;
  const points = (key: string): unknown => {
    const value = read(key) as { points?: unknown } | undefined;
    return value?.points ?? null;
  };
  const kind = CalibrationKinds.CameraProjectorSurface;
  const data = parseCalibrationData(kind, {
    homography: read(LEGACY_CALIBRATION_KEYS.Homography),
    homographyInverse: read(LEGACY_CALIBRATION_KEYS.HomographyInverse),
    homographySurface: read(LEGACY_CALIBRATION_KEYS.HomographySurface) ?? null,
    homographySurfaceInverse: read(LEGACY_CALIBRATION_KEYS.HomographySurfaceInverse) ?? null,
    focusQuad: points(LEGACY_CALIBRATION_KEYS.FocusQuad),
    surfaceQuadDisplay: points(LEGACY_CALIBRATION_KEYS.SurfaceQuadDisplay),
    surfaceSize: read(LEGACY_CALIBRATION_KEYS.SurfaceSize) ?? DEFAULT_SURFACE_SIZE,
    frameSize: read(LEGACY_CALIBRATION_KEYS.FrameSize) ?? null,
  });
  if (!data.success) return null;
  const completedAt = (status as { completedAt?: unknown }).completedAt;
  return {
    version: CALIBRATION_PROFILE_VERSION,
    kind,
    savedAt: typeof completedAt === 'number' ? completedAt : 0,
    data: data.data,
  };
}
