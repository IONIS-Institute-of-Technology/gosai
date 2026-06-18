import type { Point2D } from '@gosai/shared/homography';
import type {
  AppEventsClient,
  AppLogger,
  DriverClient,
  ExperienceRuntimeContext,
  StorageClient,
} from './types.js';

export const CALIBRATION_STATUS_KEY = 'calibration_status';
export const CAMERA_PROJECTOR_SURFACE_CALIBRATION_KIND = 'camera-projector-surface';

export const CAMERA_PROJECTOR_SURFACE_STORAGE_KEYS = {
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

export type CalibrationRole = 'control' | 'projector';

export interface SizeXY {
  readonly width: number;
  readonly height: number;
}

export interface CalibrationStatus {
  readonly ok: boolean;
  readonly completedAt: number;
  readonly kind: string;
  readonly version: number;
}

export interface CalibrationStep {
  readonly slug: string;
  readonly title: string;
  readonly help?: string;
}

export interface CalibrationStepContext {
  readonly rt: ExperienceRuntimeContext;
  readonly role: CalibrationRole;
  readonly targetAppSlug: string;
  readonly targetStorage: StorageClient;
  readonly serverBaseUrl: string;
  readonly statusKey: string;
  readonly events: AppEventsClient;
  readonly drivers: DriverClient;
  readonly log: AppLogger;
  markComplete(status?: Partial<CalibrationStatus>): Promise<void>;
  finish(ok?: boolean): Promise<void>;
}

export interface CalibrationDefinition<TState = unknown> {
  readonly slug: string;
  readonly name: string;
  readonly description?: string;
  readonly kind?: string;
  readonly steps?: readonly CalibrationStep[];
  init?: (ctx: CalibrationStepContext) => TState | Promise<TState>;
  start?: (ctx: CalibrationStepContext, state: TState) => void | Promise<void>;
  stop?: (ctx: CalibrationStepContext, state: TState) => void | Promise<void>;
}

export function defineCalibration<TState = unknown>(
  definition: CalibrationDefinition<TState>,
): CalibrationDefinition<TState> {
  return definition;
}

export type CameraProjectorSurfaceStep = 'markers' | 'pool-corners' | 'compute' | 'preview';

export interface CameraProjectorSurfaceStepCopy {
  readonly title?: string;
  readonly help?: string;
}

export interface CameraProjectorSurfaceProjectorMessages {
  readonly poolCorners?: string;
  readonly compute?: string;
  readonly done?: string;
  readonly abort?: string;
}

export interface CameraProjectorSurfaceCalibrationOptions {
  readonly slug?: string;
  readonly name?: string;
  readonly description?: string;
  readonly surfaceSize?: SizeXY;
  readonly cornerLabels?: readonly [string, string, string, string];
  readonly stepCopy?: Partial<Record<CameraProjectorSurfaceStep, CameraProjectorSurfaceStepCopy>>;
  readonly projectorMessages?: CameraProjectorSurfaceProjectorMessages;
}

export interface CameraProjectorSurfaceCalibrationDefinition extends CalibrationDefinition<unknown> {
  readonly kind: typeof CAMERA_PROJECTOR_SURFACE_CALIBRATION_KIND;
  readonly options: CameraProjectorSurfaceCalibrationOptions;
}

export function createCameraProjectorSurfaceCalibration(
  options: CameraProjectorSurfaceCalibrationOptions = {},
): CameraProjectorSurfaceCalibrationDefinition {
  const slug = options.slug ?? CAMERA_PROJECTOR_SURFACE_CALIBRATION_KIND;
  const steps: CalibrationStep[] = (['markers', 'pool-corners', 'compute', 'preview'] as const).map(
    (step) => ({
      slug: step,
      title: options.stepCopy?.[step]?.title ?? defaultStepTitle(step),
      ...(options.stepCopy?.[step]?.help ? { help: options.stepCopy[step]!.help } : {}),
    }),
  );
  return {
    slug,
    name: options.name ?? 'Camera/Projector Surface Calibration',
    ...(options.description ? { description: options.description } : {}),
    kind: CAMERA_PROJECTOR_SURFACE_CALIBRATION_KIND,
    options,
    steps,
  };
}

export function isCameraProjectorSurfaceCalibrationDefinition(
  value: CalibrationDefinition,
): value is CameraProjectorSurfaceCalibrationDefinition {
  return value.kind === CAMERA_PROJECTOR_SURFACE_CALIBRATION_KIND;
}

export interface SurfaceQuadDisplay {
  readonly points: readonly [Point2D, Point2D, Point2D, Point2D];
}

export interface CameraProjectorSurfaceCalibrationProfile {
  readonly homography: readonly number[] | null;
  readonly homographySurface: readonly number[] | null;
  readonly surfaceQuadDisplay: readonly Point2D[] | null;
  readonly surfaceSize: SizeXY | null;
  readonly frameSize: SizeXY | null;
}

export interface CameraProjectorSurfaceStorageKeys {
  readonly Homography: string;
  readonly HomographyInverse: string;
  readonly HomographySurface: string;
  readonly HomographySurfaceInverse: string;
  readonly FocusQuad: string;
  readonly SurfaceQuadDisplay: string;
  readonly SurfaceSize: string;
  readonly FrameSize: string;
  readonly MarkersLayout: string;
}

export interface LoadCameraProjectorSurfaceCalibrationOptions {
  readonly storageKeys?: Partial<CameraProjectorSurfaceStorageKeys>;
}

export async function loadCameraProjectorSurfaceCalibration(
  rt: ExperienceRuntimeContext,
  options: LoadCameraProjectorSurfaceCalibrationOptions = {},
): Promise<CameraProjectorSurfaceCalibrationProfile> {
  const keys = { ...CAMERA_PROJECTOR_SURFACE_STORAGE_KEYS, ...options.storageKeys };
  const safe = async <T>(key: string): Promise<T | null> => {
    try {
      return (await rt.storage.get<T>(key)) ?? null;
    } catch (err) {
      rt.log.warn(`calibration[${key}] fetch failed`, { err: String(err) });
      return null;
    }
  };

  const [homography, homographySurface, surfaceQuadRaw, surfaceSize, frameSize] = await Promise.all(
    [
      safe<number[]>(keys.Homography),
      safe<number[]>(keys.HomographySurface),
      safe<SurfaceQuadDisplay>(keys.SurfaceQuadDisplay),
      safe<SizeXY>(keys.SurfaceSize),
      safe<SizeXY>(keys.FrameSize),
    ],
  );

  const surfaceQuadDisplay =
    surfaceQuadRaw?.points && surfaceQuadRaw.points.length === 4
      ? [...surfaceQuadRaw.points]
      : null;

  return {
    homography,
    homographySurface,
    surfaceQuadDisplay,
    surfaceSize,
    frameSize,
  };
}

function defaultStepTitle(step: CameraProjectorSurfaceStep): string {
  switch (step) {
    case 'markers':
      return 'ArUco Markers';
    case 'pool-corners':
      return 'Surface Corners';
    case 'compute':
      return 'Compute Homography';
    case 'preview':
      return 'Preview';
  }
}
