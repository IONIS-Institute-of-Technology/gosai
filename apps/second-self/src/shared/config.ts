/**
 * Second Self configuration.
 *
 * The user-facing settings are declared once, in the manifest's `settings`
 * schema: the projection mode (webcam overlay or physical mirror rig), the
 * selfie flip and the display sleep tuning. The runtime reads them through
 * `rt.settings`; the defaults and bounds below come from the same schema.
 *
 * There is no setting about the person in front of the mirror. It stands in a
 * busy public space, so the driver sizes up each visitor by itself and draws
 * for the midpoint of their eyes.
 *
 * The physical mirror projection isn't typed in by hand either. The
 * calibration experience fits it and saves a {@link MirrorProfile} as the
 * app's calibration profile (see calibration.ts): the pose of the screen
 * behind the mirror, which the driver projects through from the viewer's eyes.
 *
 * The camera intrinsics live apart from it, in a {@link StoredLens}: they
 * belong to the camera, not to the mirror, and survive a re-calibration of it.
 */

import type { DriverTypes, ExperienceRuntimeContext } from '@gosai/sdk';
import manifest from '../../gosai.app.json';
import { REF_HEIGHT, REF_WIDTH } from './types.js';

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

/** How well the rig fit came out, for the wizard to show and for diagnostics. */
export interface RigFitReport {
  /** RMS of the fit residuals, in millimeters on the screen. */
  readonly rms_mm: number;
  /** Expected alignment error at the targets, in millimeters. */
  readonly predicted_error_mm: number;
  readonly quality: RigFitQuality;
  /** Correspondences the fit used. */
  readonly samples: number;
  /** Mean error over targets kept out of the fit, in millimeters. */
  readonly holdout_mean_mm?: number;
  /** Worst error over targets kept out of the fit, in millimeters. */
  readonly holdout_max_mm?: number;
}

export type RigFitQuality = 'good' | 'fair' | 'poor';

/** What the operator measured with a tape before the fit, in millimeters. */
export interface RigMeasurements {
  readonly screen_width_mm: number;
  readonly screen_height_mm: number;
  /** Mirror surface to pixel plane. */
  readonly gap_mm: number;
  /**
   * Camera lens above the floor, when it was measured. It lets a visitor's
   * feet on the floor set their size, so children are drawn at their own
   * scale; absent, that cue is off.
   */
  readonly camera_height_mm?: number;
}

/**
 * The calibrated mirror rig: where the screen behind the mirror sits in camera
 * coordinates, so the driver can project a body point from the viewer's eyes
 * onto it.
 *
 * `version` stays in the stored data so a profile from an older calibration is
 * recognised as unusable rather than half read.
 */
export interface MirrorProfile {
  readonly version: 2;
  /**
   * The pose the driver projects onto. `width_mm` and `height_mm` are the
   * physical size of the area the {@link REF_WIDTH} x {@link REF_HEIGHT}
   * reference canvas covers, which the wizard works out from the measured
   * screen and the canvas layout, not the screen size itself.
   */
  readonly rig: RigProfile;
  /**
   * Perceptual `[dx, dy]` nudge in reference pixels, kept out of the rig on
   * purpose: a trim must not hide a poor geometric fit.
   */
  readonly trim_px: readonly [number, number];
  /** Kept as the operator typed them, so a later run can offer them again. */
  readonly measurements: RigMeasurements;
  readonly fit: RigFitReport;
  /** Epoch ms of the calibration run. */
  readonly updatedAt: number;
}

/**
 * The camera's intrinsics, saved on their own: they describe the camera and
 * its optical path, so they outlive a mirror calibration and are reused until
 * the camera or its settings change.
 */
export interface StoredLens {
  readonly lens: LensProfile;
  /** Epoch ms of the lens calibration run. */
  readonly updatedAt: number;
}

type MirrorSettingsUpdate = DriverTypes.pose_to_mirror.MirrorSettingsUpdate;
type LensProfile = DriverTypes.pose_to_mirror.LensProfile;
type RigProfile = DriverTypes.pose_to_mirror.RigProfile;

/** How far the perceptual trim may pull the drawing, in reference pixels. */
export const TRIM_LIMIT_PX = 60;

/**
 * The pupil spacing the driver assumes for a visitor, mirroring
 * `pose_to_mirror`'s own default. Nobody in a public space measures theirs, so
 * this is a population prior rather than anyone's number. The calibration
 * pushes the operator's measured value while they check a fit, which is why
 * every update below carries this one explicitly: a preview must never outlive
 * the run that set it.
 */
export const DRIVER_IPD_MM = 63;

/**
 * The iris diameter to assume when a stored rig carries none, in millimetres:
 * the population average, which nearly everybody past the age of two is within
 * a few percent of. A rig fitted since the calibration started measuring it
 * brings its own value, which is what this camera reads an iris as rather than
 * anybody's real one.
 */
export const GENERIC_IRIS_MM = 11.7;
/** What the driver accepts for it; anything outside is corruption, not a measurement. */
const IRIS_MIN_MM = 9;
const IRIS_MAX_MM = 15;

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
  const sleepNumber = (key: keyof SleepConfig & string, fallback: number): number =>
    boundedNumber(`sleep.${key}`, sleep[key], fallback);
  return {
    projection: {
      mode: pickEnum(projection.mode, MODES, base.projection.mode),
      mirror: pickBool(projection.mirror, base.projection.mirror),
    },
    sleep: {
      enabled: pickBool(sleep.enabled, base.sleep.enabled),
      wakeConfidence: sleepNumber('wakeConfidence', base.sleep.wakeConfidence),
      sleepConfidence: sleepNumber('sleepConfidence', base.sleep.sleepConfidence),
      sleepDelaySec: sleepNumber('sleepDelaySec', base.sleep.sleepDelaySec),
      maxDistanceM: sleepNumber('maxDistanceM', base.sleep.maxDistanceM),
    },
  };
}

/**
 * How the camera frame fills the portrait reference space in direct mode.
 *
 * `cover` crops the frame to the display's aspect instead of letterboxing it,
 * so a hand can reach every on-screen position. Under `contain` a landscape
 * webcam only ever lands in a band across the middle of the portrait space,
 * leaving the menu button and anything else near an edge untouchable, which is
 * what a landscape test window looks like. Reflection mode ignores this: there
 * the calibration fits the mapping.
 */
const CAMERA_FIT = 'cover';

/**
 * The `set_mirror_config` update for the projection settings plus the saved
 * calibration.
 *
 * A profile sends the rig, its trim and the saved lens; without one the rig is
 * cleared, which leaves reflection mode with no geometry and the driver says
 * so. `ipd_mm` is always written: the calibration previews a fit with the
 * operator's own pupil distance, and this is what takes it back off.
 */
export function toMirrorDriverConfig(
  cfg: SecondSelfConfig,
  profile: MirrorProfile | null,
  lens: StoredLens | null = null,
): MirrorSettingsUpdate {
  return {
    mode: cfg.projection.mode,
    mirror: cfg.projection.mirror,
    fit: CAMERA_FIT,
    width: REF_WIDTH,
    height: REF_HEIGHT,
    ipd_mm: DRIVER_IPD_MM,
    ...(profile
      ? { rig: profile.rig, trim_px: [...profile.trim_px], lens: lens?.lens ?? null }
      : { rig: null }),
  };
}

/** A valid {@link MirrorProfile}, or `null`. */
export function parseMirrorProfile(value: unknown): MirrorProfile | null {
  if (!isObject(value) || value.version !== 2) return null;
  const rig = parseRigProfile(value.rig);
  const measurements = parseRigMeasurements(value.measurements);
  const fit = parseRigFit(value.fit);
  const trim = parseTrim(value.trim_px);
  const { updatedAt } = value;
  if (!rig || !measurements || !fit || !trim || !isFiniteNumber(updatedAt)) return null;
  return { version: 2, rig, trim_px: trim, measurements, fit, updatedAt };
}

function parseRigProfile(value: unknown): RigProfile | null {
  if (!isObject(value)) return null;
  const rotation = vector(value.rotation, 3);
  const center_mm = vector(value.center_mm, 3);
  const { width_mm, height_mm } = value;
  const gap_mm = value.gap_mm ?? 0;
  const camera_height_mm = value.camera_height_mm ?? null;
  // Profiles saved before the calibration measured an iris carry none, and the
  // population average is what the driver assumed for them all along.
  const iris_mm = value.iris_mm ?? GENERIC_IRIS_MM;
  if (!rotation || !center_mm) return null;
  if (!isPositive(width_mm) || !isPositive(height_mm) || !isAtLeastZero(gap_mm)) return null;
  if (camera_height_mm !== null && !isPositive(camera_height_mm)) return null;
  if (!isFiniteNumber(iris_mm) || iris_mm < IRIS_MIN_MM || iris_mm > IRIS_MAX_MM) return null;
  return {
    rotation: [...rotation],
    center_mm: [...center_mm],
    width_mm,
    height_mm,
    gap_mm,
    camera_height_mm,
    iris_mm,
  };
}

function parseRigMeasurements(value: unknown): RigMeasurements | null {
  if (!isObject(value)) return null;
  const { screen_width_mm, screen_height_mm, gap_mm, camera_height_mm } = value;
  if (!isPositive(screen_width_mm) || !isPositive(screen_height_mm)) return null;
  if (!isAtLeastZero(gap_mm)) return null;
  if (camera_height_mm !== undefined && !isPositive(camera_height_mm)) return null;
  return {
    screen_width_mm,
    screen_height_mm,
    gap_mm,
    ...(camera_height_mm === undefined ? {} : { camera_height_mm }),
  };
}

const QUALITIES: readonly RigFitQuality[] = ['good', 'fair', 'poor'];

function parseRigFit(value: unknown): RigFitReport | null {
  if (!isObject(value)) return null;
  const { rms_mm, predicted_error_mm, samples, holdout_mean_mm, holdout_max_mm } = value;
  const quality = QUALITIES.find((known) => known === value.quality);
  if (!quality || !isAtLeastZero(rms_mm) || !isAtLeastZero(predicted_error_mm)) return null;
  if (!isAtLeastZero(samples)) return null;
  if (!isOptionalFinite(holdout_mean_mm) || !isOptionalFinite(holdout_max_mm)) return null;
  return {
    rms_mm,
    predicted_error_mm,
    quality,
    samples,
    ...(holdout_mean_mm === undefined ? {} : { holdout_mean_mm }),
    ...(holdout_max_mm === undefined ? {} : { holdout_max_mm }),
  };
}

/** A missing trim is no trim; a stored one is clamped, however it was written. */
function parseTrim(value: unknown): readonly [number, number] | null {
  if (value === undefined) return [0, 0];
  const trim = vector(value, 2);
  if (!trim) return null;
  const clamp = (n: number): number => Math.min(TRIM_LIMIT_PX, Math.max(-TRIM_LIMIT_PX, n));
  return [clamp(trim[0]), clamp(trim[1])];
}

/** A valid {@link StoredLens}, or `null`. */
export function parseStoredLens(value: unknown): StoredLens | null {
  if (!isObject(value)) return null;
  const lens = parseLensProfile(value.lens);
  const { updatedAt } = value;
  if (!lens || !isFiniteNumber(updatedAt)) return null;
  return { lens, updatedAt };
}

function parseLensProfile(value: unknown): LensProfile | null {
  if (!isObject(value)) return null;
  const { width, height, fx, fy, cx, cy, rms_px } = value;
  const dist = numberList(value.dist ?? []);
  if (!isPositive(width) || !isPositive(height) || !isPositive(fx) || !isPositive(fy)) return null;
  if (!isFiniteNumber(cx) || !isFiniteNumber(cy) || !dist) return null;
  // The driver reports no RMS when the fit did not measure one.
  if (rms_px !== null && !isOptionalFinite(rms_px)) return null;
  return { width, height, fx, fy, cx, cy, dist, ...(isFiniteNumber(rms_px) ? { rms_px } : {}) };
}

// ---------------------------------------------------------------------------

function numberDefault(key: string): number {
  const value = field(key).default;
  if (typeof value !== 'number') throw new Error(`setting ${key} has no number default`);
  return value;
}

/** `value` clamped to the manifest bounds of `key`, or `fallback`. */
function boundedNumber(key: string, value: unknown, fallback: number): number {
  const { min = -Infinity, max = Infinity } = field(key);
  return isFiniteNumber(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isOptionalFinite(value: unknown): value is number | undefined {
  return value === undefined || isFiniteNumber(value);
}

function isPositive(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0;
}

function isAtLeastZero(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

function numberList(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const numbers: number[] = [];
  for (const entry of value) {
    if (!isFiniteNumber(entry)) return null;
    numbers.push(entry);
  }
  return numbers;
}

/** Exactly `length` finite numbers, as a tuple, or `null`. */
function vector(value: unknown, length: 2): readonly [number, number] | null;
function vector(value: unknown, length: 3): readonly [number, number, number] | null;
function vector(value: unknown, length: number): readonly number[] | null {
  const numbers = numberList(value);
  return numbers && numbers.length === length ? numbers : null;
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
