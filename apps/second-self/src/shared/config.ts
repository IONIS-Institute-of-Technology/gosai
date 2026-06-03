/**
 * Second Self runtime configuration.
 *
 * One persisted, JSON-serializable config object drives how the app adapts to
 * different hardware. It is read from the app's key/value storage (key
 * {@link CONFIG_STORAGE_KEY}) on start and deep-merged over {@link DEFAULT_CONFIG},
 * so installs can reconfigure without rebuilding. The three concerns are
 * independent:
 *
 * - `projection` — how the **camera frame** maps into the reference space
 *   (handles any webcam resolution/aspect; mirror vs. no-mirror).
 * - `display` — how the **reference space** maps onto the **physical screen**
 *   (handles any screen size/orientation, distortion-free).
 * - `mirror` — physical augmented-mirror calibration, used only when
 *   `projection.mode === 'reflection'`.
 *
 * Set it from any GOSAI storage tool, e.g.:
 * `POST /v1/apps/second-self/storage/config` with the JSON body.
 */

import type { ExperienceRuntimeContext } from '@gosai/sdk';
import type { DisplayFit } from './canvas.js';
import { REF_HEIGHT, REF_WIDTH } from './types.js';

export const CONFIG_STORAGE_KEY = 'config';

export type ProjectionMode = 'direct' | 'reflection';
export type CameraFit = 'contain' | 'cover';

export interface ProjectionConfig {
  /** `direct` = webcam selfie overlay; `reflection` = physical mirror rig. */
  mode: ProjectionMode;
  /** Horizontal flip for a selfie view (direct mode). */
  mirror: boolean;
  /** How the camera frame fills the reference space (direct mode). */
  cameraFit: CameraFit;
  /** Extra zoom (>1 crops in for a fuller portrait fill). */
  zoom: number;
}

export interface DisplayConfig {
  /** Logical design space width (experiences are authored portrait). */
  referenceWidth: number;
  referenceHeight: number;
  /** How the reference space maps onto the physical screen. */
  fit: DisplayFit;
}

/** Physical augmented-mirror calibration (reflection mode only; mm). */
export interface MirrorCalibration {
  x_offset: number;
  y_offset: number;
  screen_width_mm: number;
  screen_height_mm: number;
  tilt_deg: number;
  hfov_deg: number;
  scale: number;
  default_distance_mm: number;
}

export interface SecondSelfConfig {
  projection: ProjectionConfig;
  display: DisplayConfig;
  mirror: MirrorCalibration;
}

export const DEFAULT_CONFIG: SecondSelfConfig = {
  projection: {
    mode: 'direct',
    mirror: true,
    cameraFit: 'contain',
    zoom: 1.0,
  },
  display: {
    referenceWidth: REF_WIDTH,
    referenceHeight: REF_HEIGHT,
    fit: 'contain',
  },
  // Defaults from the legacy second-self config.json (physical rig).
  mirror: {
    x_offset: -230,
    y_offset: 100,
    screen_width_mm: 392.85,
    screen_height_mm: 698.4,
    tilt_deg: 17,
    hfov_deg: 60,
    scale: 1.0,
    default_distance_mm: 1500,
  },
};

/** Read + validate the stored config, deep-merged over the defaults. */
export async function loadConfig(rt: ExperienceRuntimeContext): Promise<SecondSelfConfig> {
  let stored: unknown = null;
  try {
    stored = await rt.storage.get<unknown>(CONFIG_STORAGE_KEY, null);
  } catch (err) {
    rt.log.warn('second-self: failed to read config, using defaults', { err: String(err) });
  }
  return mergeConfig(DEFAULT_CONFIG, stored);
}

/**
 * Build the `set_mirror_config` action payload for the `pose_to_mirror` driver
 * from a config object (flattens projection + mirror calibration).
 */
export function toMirrorDriverConfig(cfg: SecondSelfConfig): Record<string, unknown> {
  return {
    mode: cfg.projection.mode,
    mirror: cfg.projection.mirror,
    fit: cfg.projection.cameraFit,
    zoom: cfg.projection.zoom,
    width: cfg.display.referenceWidth,
    height: cfg.display.referenceHeight,
    x_offset: cfg.mirror.x_offset,
    y_offset: cfg.mirror.y_offset,
    screen_width_mm: cfg.mirror.screen_width_mm,
    screen_height_mm: cfg.mirror.screen_height_mm,
    tilt_deg: cfg.mirror.tilt_deg,
    hfov_deg: cfg.mirror.hfov_deg,
    scale: cfg.mirror.scale,
    default_distance_mm: cfg.mirror.default_distance_mm,
  };
}

// ---------------------------------------------------------------------------

function mergeConfig(base: SecondSelfConfig, override: unknown): SecondSelfConfig {
  if (typeof override !== 'object' || override === null) return base;
  const o = override as Partial<SecondSelfConfig>;
  return {
    projection: {
      mode: pickEnum(o.projection?.mode, ['direct', 'reflection'], base.projection.mode),
      mirror: pickBool(o.projection?.mirror, base.projection.mirror),
      cameraFit: pickEnum(o.projection?.cameraFit, ['contain', 'cover'], base.projection.cameraFit),
      zoom: pickNumber(o.projection?.zoom, base.projection.zoom),
    },
    display: {
      referenceWidth: pickNumber(o.display?.referenceWidth, base.display.referenceWidth),
      referenceHeight: pickNumber(o.display?.referenceHeight, base.display.referenceHeight),
      fit: pickEnum(o.display?.fit, ['contain', 'cover', 'stretch'], base.display.fit),
    },
    mirror: {
      x_offset: pickNumber(o.mirror?.x_offset, base.mirror.x_offset),
      y_offset: pickNumber(o.mirror?.y_offset, base.mirror.y_offset),
      screen_width_mm: pickNumber(o.mirror?.screen_width_mm, base.mirror.screen_width_mm),
      screen_height_mm: pickNumber(o.mirror?.screen_height_mm, base.mirror.screen_height_mm),
      tilt_deg: pickNumber(o.mirror?.tilt_deg, base.mirror.tilt_deg),
      hfov_deg: pickNumber(o.mirror?.hfov_deg, base.mirror.hfov_deg),
      scale: pickNumber(o.mirror?.scale, base.mirror.scale),
      default_distance_mm: pickNumber(
        o.mirror?.default_distance_mm,
        base.mirror.default_distance_mm,
      ),
    },
  };
}

function pickNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function pickBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function pickEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}
