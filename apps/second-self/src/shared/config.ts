/**
 * Second Self configuration.
 *
 * The user-facing settings are declared once, in the manifest's `settings`
 * schema: the projection mode (webcam overlay or physical mirror rig), the
 * selfie flip and the display sleep tuning. The runtime reads them through
 * `rt.settings`; the defaults and bounds below come from the same schema.
 *
 * The physical mirror projection isn't typed in by hand. The in-app
 * calibration wizard fits it and stores a {@link MirrorProfile} under
 * {@link MIRROR_PROFILE_STORAGE_KEY}.
 */

import type { DriverTypes, ExperienceRuntimeContext } from '@gosai/sdk';
import manifest from '../../gosai.app.json';
import { REF_HEIGHT, REF_WIDTH } from './types.js';

export const MIRROR_PROFILE_STORAGE_KEY = 'mirror_calibration';

type ProjectionMode = 'direct' | 'reflection';

interface ProjectionConfig {
  /** `direct` = webcam selfie overlay; `reflection` = physical mirror rig. */
  readonly mode: ProjectionMode;
  /** Horizontal flip for a selfie view (direct mode). */
  readonly mirror: boolean;
}

export interface SleepConfig {
  /** Master switch for presence-based display sleep. */
  readonly enabled: boolean;
  /** Smoothed presence confidence required to wake the display (0..1). */
  readonly wakeConfidence: number;
  /** Below this smoothed confidence the user counts as absent (0..1). */
  readonly sleepConfidence: number;
  /** Seconds of continuous absence before the display falls asleep. */
  readonly sleepDelaySec: number;
  /** People estimated farther than this (meters) are ignored. */
  readonly maxDistanceM: number;
}

export interface SecondSelfConfig {
  readonly projection: ProjectionConfig;
  readonly sleep: SleepConfig;
}

/** Fitted mirror calibration, produced by the wizard and applied in reflection mode. */
export interface MirrorProfile {
  /** Camera tilt in degrees. */
  readonly tilt_deg: number;
  /** Distance-estimate correction factor. */
  readonly scale: number;
  /** mm to mirror-pixel affine `[ax, bx, ay, by]`. */
  readonly affine: readonly [number, number, number, number];
  /** Mean residual of the fit in reference pixels (informational). */
  readonly residual_px_mean?: number;
  /** Epoch ms of the calibration run (informational). */
  readonly updatedAt?: number;
}

type MirrorSettingsUpdate = DriverTypes.pose_to_mirror.MirrorSettingsUpdate;

/** The parts of a manifest settings field this module reads. */
interface ManifestField {
  readonly key: string;
  readonly default?: unknown;
  readonly min?: number;
  readonly max?: number;
}

const GROUPS: readonly { readonly fields: readonly ManifestField[] }[] = manifest.settings.groups;
const FIELDS = new Map(GROUPS.flatMap((group) => group.fields).map((f) => [f.key, f]));

function field(key: string): ManifestField {
  const found = FIELDS.get(key);
  if (!found) throw new Error(`gosai.app.json declares no setting ${key}`);
  return found;
}

const MODES: readonly ProjectionMode[] = ['direct', 'reflection'];

/** The manifest defaults. Frozen: build new objects instead of editing it. */
export const DEFAULT_CONFIG: SecondSelfConfig = deepFreeze({
  projection: {
    mode: pickEnum(field('projection.mode').default, MODES, 'direct'),
    mirror: pickBool(field('projection.mirror').default, true),
  },
  sleep: {
    enabled: pickBool(field('sleep.enabled').default, true),
    wakeConfidence: numberDefault('sleep.wakeConfidence'),
    sleepConfidence: numberDefault('sleep.sleepConfidence'),
    sleepDelaySec: numberDefault('sleep.sleepDelaySec'),
    maxDistanceM: numberDefault('sleep.maxDistanceM'),
  },
});

/** Reads the settings, validated and merged over {@link DEFAULT_CONFIG}. */
export async function loadConfig(rt: ExperienceRuntimeContext): Promise<SecondSelfConfig> {
  try {
    return mergeConfig(DEFAULT_CONFIG, await rt.settings.get());
  } catch (err) {
    rt.log.warn('second-self: failed to read settings, using defaults', { err: String(err) });
    return mergeConfig(DEFAULT_CONFIG, null);
  }
}

/**
 * Validates `override` field by field over `base`: unknown or invalid values
 * fall back to `base`, numbers are clamped to the manifest bounds. Always
 * returns a new object.
 */
export function mergeConfig(base: SecondSelfConfig, override: unknown): SecondSelfConfig {
  const projection = asObject(asObject(override).projection);
  const sleep = asObject(asObject(override).sleep);
  const number = (key: keyof SleepConfig & string, fallback: number): number => {
    const { min = -Infinity, max = Infinity } = field(`sleep.${key}`);
    const value = sleep[key];
    return typeof value === 'number' && Number.isFinite(value)
      ? Math.min(max, Math.max(min, value))
      : fallback;
  };
  return {
    projection: {
      mode: pickEnum(projection.mode, MODES, base.projection.mode),
      mirror: pickBool(projection.mirror, base.projection.mirror),
    },
    sleep: {
      enabled: pickBool(sleep.enabled, base.sleep.enabled),
      wakeConfidence: number('wakeConfidence', base.sleep.wakeConfidence),
      sleepConfidence: number('sleepConfidence', base.sleep.sleepConfidence),
      sleepDelaySec: number('sleepDelaySec', base.sleep.sleepDelaySec),
      maxDistanceM: number('maxDistanceM', base.sleep.maxDistanceM),
    },
  };
}

/** Reads the stored mirror calibration profile, if there is a valid one. */
export async function loadMirrorProfile(
  rt: ExperienceRuntimeContext,
): Promise<MirrorProfile | null> {
  try {
    return parseMirrorProfile(await rt.storage.get(MIRROR_PROFILE_STORAGE_KEY));
  } catch (err) {
    rt.log.warn('second-self: failed to read mirror profile', { err: String(err) });
    return null;
  }
}

/**
 * The `set_mirror_config` update for the projection settings plus the fitted
 * profile. Without a profile the driver drops any fitted affine.
 */
export function toMirrorDriverConfig(
  cfg: SecondSelfConfig,
  profile: MirrorProfile | null,
): MirrorSettingsUpdate {
  return {
    mode: cfg.projection.mode,
    mirror: cfg.projection.mirror,
    width: REF_WIDTH,
    height: REF_HEIGHT,
    ...(profile
      ? { tilt_deg: profile.tilt_deg, scale: profile.scale, affine: [...profile.affine] }
      : { affine: null }),
  };
}

function parseMirrorProfile(value: unknown): MirrorProfile | null {
  if (!isObject(value)) return null;
  const { affine, tilt_deg, scale, residual_px_mean, updatedAt } = value;
  if (
    !Array.isArray(affine) ||
    affine.length !== 4 ||
    !affine.every((n) => typeof n === 'number' && Number.isFinite(n))
  ) {
    return null;
  }
  if (typeof tilt_deg !== 'number' || typeof scale !== 'number') return null;
  return {
    tilt_deg,
    scale,
    affine: [affine[0], affine[1], affine[2], affine[3]],
    ...(typeof residual_px_mean === 'number' ? { residual_px_mean } : {}),
    ...(typeof updatedAt === 'number' ? { updatedAt } : {}),
  };
}

// ---------------------------------------------------------------------------

function numberDefault(key: string): number {
  const value = field(key).default;
  if (typeof value !== 'number') throw new Error(`setting ${key} has no number default`);
  return value;
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asObject(value: unknown): Readonly<Record<string, unknown>> {
  return isObject(value) ? value : {};
}

function pickBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function pickEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.find((option) => option === value) ?? fallback;
}

function deepFreeze<T extends object>(value: T): T {
  for (const child of Object.values(value)) {
    if (typeof child === 'object' && child !== null) deepFreeze(child);
  }
  return Object.freeze(value);
}
