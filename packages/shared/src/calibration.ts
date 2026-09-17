/**
 * The calibration contract.
 *
 * An app declares calibration in its manifest (`calibration`, see
 * {@link AppCalibrationSchema}): a `kind`, kind-specific `options`, whether
 * the app is `required` to be calibrated before it starts, and optionally an
 * `experience` of its own that runs a custom flow.
 *
 * Built-in kinds run in the built-in calibration app ({@link CALIBRATION_RUNNER}).
 * Custom flows run the app's own experience. Either way the flow opens a
 * control window and a projector window, saves one versioned
 * {@link CalibrationProfile} for the app with the `calibration:save` command,
 * and ends by broadcasting {@link CalibrationWizardTopics.Finished} on its
 * app's events.
 *
 * Zod-free, so the SDK bundle and Electron main can import it.
 */

// ── Kinds ──────────────────────────────────────────────────────────────────

export const CalibrationKinds = {
  /** A camera watches a surface a projector draws on. */
  CameraProjectorSurface: 'camera-projector-surface',
} as const;

export type BuiltinCalibrationKind = (typeof CalibrationKinds)[keyof typeof CalibrationKinds];

export const BUILTIN_CALIBRATION_KINDS: readonly BuiltinCalibrationKind[] =
  Object.values(CalibrationKinds);

export function isBuiltinCalibrationKind(kind: string): kind is BuiltinCalibrationKind {
  return (BUILTIN_CALIBRATION_KINDS as readonly string[]).includes(kind);
}

/** Kind names look like slugs: `camera-projector-surface`, `acme-depth-grid`. */
export const CALIBRATION_KIND_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

// ── Manifest ───────────────────────────────────────────────────────────────

/** The manifest's `calibration` object. */
export interface AppCalibrationSchema {
  /**
   * What the calibration produces. A built-in kind, or any kind name when
   * `experience` runs the flow.
   */
  readonly kind: string;
  /** The app must be calibrated before it starts. Defaults to `false`. */
  readonly required: boolean;
  /**
   * Settings for the flow. Validated for built-in kinds, see
   * {@link CameraProjectorSurfaceOptions}; passed through for custom ones.
   */
  readonly options?: Readonly<Record<string, unknown>>;
  /**
   * One of the app's own experiences that runs the flow instead of the
   * built-in calibration app. Required for kinds that aren't built in.
   */
  readonly experience?: string;
}

/** The built-in app that runs flows for built-in kinds. */
export const CALIBRATION_RUNNER = {
  appSlug: 'calibration',
  experienceSlug: 'calibrate',
} as const;

/** Which app and experience run the calibration of an app with this schema. */
export function calibrationFlow(
  appSlug: string,
  calibration: AppCalibrationSchema,
): { readonly appSlug: string; readonly experienceSlug: string } {
  if (calibration.experience !== undefined) {
    return { appSlug, experienceSlug: calibration.experience };
  }
  return CALIBRATION_RUNNER;
}

// ── Windows and events ─────────────────────────────────────────────────────

/** A calibration flow runs in a control window and a projector window. */
export type CalibrationRole = 'control' | 'projector';

/** Launch parameters of calibration windows, read with `rt.app.params`. */
export const CalibrationParams = {
  /** `control` or `projector`. */
  Role: 'role',
  /** Slug of the app being calibrated. */
  Target: 'target',
} as const;

/** App event topics of a calibration flow, broadcast with `rt.events`. */
export const CalibrationWizardTopics = {
  /** The control window moved to another step: `{ step, ... }`. */
  Step: 'wizard:step',
  /** The flow ended. The payload is a {@link CalibrationResult}. */
  Finished: 'wizard:finished',
} as const;

/** How a calibration flow ended. */
export type CalibrationResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly error: string;
      /** The operator cancelled or closed the flow, as opposed to a failure. */
      readonly cancelled?: boolean;
    };

// ── Profiles ───────────────────────────────────────────────────────────────

/** Storage key of an app's calibration profile. */
export const CALIBRATION_PROFILE_KEY = 'calibration_profile';

export const CALIBRATION_PROFILE_VERSION = 1;

/** What a flow saves with `calibration:save`. */
export interface CalibrationProfileInput<K extends string = string, D = unknown> {
  readonly kind: K;
  readonly data: D;
}

/** An app's saved calibration. The server sets `version` and `savedAt`. */
export interface CalibrationProfile<
  K extends string = string,
  D = unknown,
> extends CalibrationProfileInput<K, D> {
  readonly version: typeof CALIBRATION_PROFILE_VERSION;
  /** Milliseconds since the Unix epoch. */
  readonly savedAt: number;
}

/** An app is calibrated when it saved a profile of the kind its manifest declares. */
export function isCalibrated(
  calibration: Pick<AppCalibrationSchema, 'kind'> | undefined,
  profile: Pick<CalibrationProfile, 'kind' | 'version'> | null,
): boolean {
  return (
    calibration !== undefined &&
    profile !== null &&
    profile.version === CALIBRATION_PROFILE_VERSION &&
    profile.kind === calibration.kind
  );
}

// ── camera-projector-surface ───────────────────────────────────────────────

export interface CalibrationPoint {
  readonly x: number;
  readonly y: number;
}

/** Four corners: top-left, top-right, bottom-right, bottom-left. */
export type CalibrationQuad = readonly [
  CalibrationPoint,
  CalibrationPoint,
  CalibrationPoint,
  CalibrationPoint,
];

export interface CalibrationSize {
  readonly width: number;
  readonly height: number;
}

/** Steps of the camera-projector-surface flow. */
export type CameraProjectorSurfaceStep = 'markers' | 'surface-corners' | 'compute' | 'preview';

export interface CameraProjectorSurfaceStepCopy {
  readonly title?: string;
  readonly help?: string;
}

/** `calibration.options` of the camera-projector-surface kind. */
export interface CameraProjectorSurfaceOptions {
  /** The reference resolution the app renders in. Defaults to 1920x1080. */
  readonly surfaceSize?: CalibrationSize;
  /** Labels of the four surface corners. Defaults to TL, TR, BR, BL. */
  readonly cornerLabels?: readonly [string, string, string, string];
  /** Titles and help text of the control window, per step. */
  readonly stepCopy?: Readonly<
    Partial<Record<CameraProjectorSurfaceStep, CameraProjectorSurfaceStepCopy>>
  >;
  /** Text the projector shows while the operator works in the control window. */
  readonly projectorMessages?: {
    readonly surfaceCorners?: string;
    readonly compute?: string;
    readonly done?: string;
    readonly cancelled?: string;
  };
}

/**
 * Profile data of the camera-projector-surface kind. Matrices are 3x3,
 * flattened row by row, as OpenCV lays them out.
 */
export interface CameraProjectorSurfaceCalibration {
  /** Camera pixels to projector display pixels. */
  readonly homography: readonly number[];
  readonly homographyInverse: readonly number[];
  /**
   * Camera pixels to the surface reference space (`surfaceSize`), which
   * tracking drivers such as `ball` and `hand_pose` consume. `null` when no
   * surface corners were picked.
   */
  readonly homographySurface: readonly number[] | null;
  readonly homographySurfaceInverse: readonly number[] | null;
  /** The surface corners in normalised camera coordinates (0..1). */
  readonly focusQuad: CalibrationQuad | null;
  /** The surface corners in projector display pixels, for a CSS keystone warp. */
  readonly surfaceQuadDisplay: CalibrationQuad | null;
  readonly surfaceSize: CalibrationSize;
  /** The camera frame size the homographies were computed at. */
  readonly frameSize: CalibrationSize | null;
}

export const DEFAULT_SURFACE_SIZE: CalibrationSize = { width: 1920, height: 1080 };
