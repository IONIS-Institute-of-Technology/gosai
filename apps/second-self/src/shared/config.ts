/**
 * Second Self runtime configuration.
 *
 * Configuration is deliberately minimal: the only user-facing choices are the
 * projection mode (webcam overlay vs. physical mirror rig) and the selfie
 * flip. Everything else is automatic:
 *
 * - The reference space is fixed at 1080x1920 and `contain`-fit onto the
 *   screen, so any portrait display (including 9:16 WQHD) fills exactly and
 *   other aspects letterbox without distortion.
 * - The physical-mirror projection parameters are not typed in by hand; they
 *   are *fitted* by the in-app calibration wizard (`calibrate` layer) and
 *   persisted as a {@link MirrorProfile} under {@link MIRROR_PROFILE_STORAGE_KEY}.
 *
 * The projection config is read from the app's key/value storage (key
 * {@link CONFIG_STORAGE_KEY}) on start and merged over {@link DEFAULT_CONFIG}.
 */

import type { ExperienceRuntimeContext } from '@gosai/sdk';
import { REF_HEIGHT, REF_WIDTH } from './types.js';

export const CONFIG_STORAGE_KEY = 'config';
export const MIRROR_PROFILE_STORAGE_KEY = 'mirror_calibration';

export type ProjectionMode = 'direct' | 'reflection';

export interface ProjectionConfig {
  /** `direct` = webcam selfie overlay; `reflection` = physical mirror rig. */
  mode: ProjectionMode;
  /** Horizontal flip for a selfie view (direct mode). */
  mirror: boolean;
}

export interface SleepConfig {
  /** Master switch for presence-based display sleep. */
  enabled: boolean;
  /** Smoothed presence confidence required to wake the display (0..1). */
  wakeConfidence: number;
  /** Below this smoothed confidence the user counts as absent (0..1). */
  sleepConfidence: number;
  /** Seconds of continuous absence before the display falls asleep. */
  sleepDelaySec: number;
}

export interface SecondSelfConfig {
  projection: ProjectionConfig;
  sleep: SleepConfig;
}

/**
 * Fitted mirror calibration, produced by the calibration wizard and applied
 * to the `pose_to_mirror` driver on start (reflection mode only).
 */
export interface MirrorProfile {
  /** Camera tilt in degrees (fitted). */
  tilt_deg: number;
  /** Distance-estimate correction factor (fitted). */
  scale: number;
  /** mm -> mirror-pixel affine `[ax, bx, ay, by]` (fitted). */
  affine: [number, number, number, number];
  /** Mean residual of the fit in reference pixels (informational). */
  residual_px_mean?: number;
  /** Epoch ms of the calibration run (informational). */
  updatedAt?: number;
}

export const DEFAULT_CONFIG: SecondSelfConfig = {
  projection: {
    mode: 'direct',
    mirror: true,
  },
  sleep: {
    enabled: true,
    wakeConfidence: 0.6,
    sleepConfidence: 0.35,
    sleepDelaySec: 12,
  },
};

/** Read + validate the stored config, merged over the defaults. */
export async function loadConfig(rt: ExperienceRuntimeContext): Promise<SecondSelfConfig> {
  let stored: unknown = null;
  try {
    stored = await rt.storage.get<unknown>(CONFIG_STORAGE_KEY, null);
  } catch (err) {
    rt.log.warn('second-self: failed to read config, using defaults', { err: String(err) });
  }
  return mergeConfig(DEFAULT_CONFIG, stored);
}

/** Read + validate the stored mirror calibration profile, if any. */
export async function loadMirrorProfile(
  rt: ExperienceRuntimeContext,
): Promise<MirrorProfile | null> {
  let stored: unknown = null;
  try {
    stored = await rt.storage.get<unknown>(MIRROR_PROFILE_STORAGE_KEY, null);
  } catch (err) {
    rt.log.warn('second-self: failed to read mirror profile', { err: String(err) });
    return null;
  }
  return parseMirrorProfile(stored);
}

/** Persist the mirror calibration profile produced by the wizard. */
export async function saveMirrorProfile(
  rt: ExperienceRuntimeContext,
  profile: MirrorProfile,
): Promise<void> {
  await rt.storage.set(MIRROR_PROFILE_STORAGE_KEY, profile);
}

/**
 * Build the `set_mirror_config` action payload for the `pose_to_mirror` driver
 * from the projection config plus the fitted profile (when present).
 */
export function toMirrorDriverConfig(
  cfg: SecondSelfConfig,
  profile: MirrorProfile | null,
): Record<string, unknown> {
  return {
    mode: cfg.projection.mode,
    mirror: cfg.projection.mirror,
    width: REF_WIDTH,
    height: REF_HEIGHT,
    ...(profile
      ? {
          tilt_deg: profile.tilt_deg,
          scale: profile.scale,
          affine: profile.affine,
        }
      : {}),
  };
}

// ---------------------------------------------------------------------------

function mergeConfig(base: SecondSelfConfig, override: unknown): SecondSelfConfig {
  if (typeof override !== 'object' || override === null) return base;
  const o = override as { projection?: Partial<ProjectionConfig>; sleep?: Partial<SleepConfig> };
  return {
    projection: {
      mode: pickEnum(o.projection?.mode, ['direct', 'reflection'], base.projection.mode),
      mirror: pickBool(o.projection?.mirror, base.projection.mirror),
    },
    sleep: {
      enabled: pickBool(o.sleep?.enabled, base.sleep.enabled),
      wakeConfidence: pickNumber(o.sleep?.wakeConfidence, base.sleep.wakeConfidence, 0, 1),
      sleepConfidence: pickNumber(o.sleep?.sleepConfidence, base.sleep.sleepConfidence, 0, 1),
      sleepDelaySec: pickNumber(o.sleep?.sleepDelaySec, base.sleep.sleepDelaySec, 0, 3600),
    },
  };
}

function parseMirrorProfile(value: unknown): MirrorProfile | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  const affine = v.affine;
  if (
    !Array.isArray(affine) ||
    affine.length !== 4 ||
    !affine.every((n) => typeof n === 'number' && Number.isFinite(n))
  ) {
    return null;
  }
  if (typeof v.tilt_deg !== 'number' || typeof v.scale !== 'number') return null;
  return {
    tilt_deg: v.tilt_deg,
    scale: v.scale,
    affine: affine as [number, number, number, number],
    ...(typeof v.residual_px_mean === 'number' ? { residual_px_mean: v.residual_px_mean } : {}),
    ...(typeof v.updatedAt === 'number' ? { updatedAt: v.updatedAt } : {}),
  };
}

function pickNumber(value: unknown, fallback: number, lo: number, hi: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(hi, Math.max(lo, value))
    : fallback;
}

function pickBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function pickEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}
