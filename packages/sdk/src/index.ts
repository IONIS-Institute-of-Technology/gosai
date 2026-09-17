/**
 * @gosai/sdk - SDK for building GOSAI applications.
 *
 * App authors typically only need:
 *   - `defineExperience` to declare an experience
 *   - `runExperience` (rare; usually invoked by the host)
 *   - The exported types
 */

export { defineExperience } from './experience.js';
export { runExperience } from './runtime.js';
export type { RuntimeHandle, RuntimeOptions } from './runtime.js';

export {
  computeFit,
  createCanvas,
  createFullscreenCanvas,
  fitCanvas,
  fullscreenContainer,
} from './canvas.js';
export type {
  CanvasOptions,
  FitMode,
  FitTransform,
  FittableCanvas,
  FullscreenCanvas,
  FullscreenCanvasOptions,
  Size,
} from './canvas.js';

export { LayerManager } from './layers.js';
export type { Layer, LayerDefinition, LayerManagerOptions, LayerPhase } from './layers.js';

export { applyQuadWarp, clearQuadWarp } from './warp.js';
export type { QuadWarpOptions, WarpTarget } from './warp.js';

export { ServerClient } from './connection.js';
export type { ConnectionStatus } from './connection.js';
export { createStorageClient } from './storage.js';

export {
  CALIBRATION_STATUS_KEY,
  CAMERA_PROJECTOR_SURFACE_CALIBRATION_KIND,
  CAMERA_PROJECTOR_SURFACE_STORAGE_KEYS,
  createCameraProjectorSurfaceCalibration,
  defineCalibration,
  isCameraProjectorSurfaceCalibrationDefinition,
  loadCameraProjectorSurfaceCalibration,
} from './calibration.js';
export type {
  CalibrationDefinition,
  CalibrationRole,
  CalibrationStatus,
  CalibrationStep,
  CalibrationStepContext,
  CameraProjectorSurfaceCalibrationDefinition,
  CameraProjectorSurfaceCalibrationOptions,
  CameraProjectorSurfaceCalibrationProfile,
  CameraProjectorSurfaceProjectorMessages,
  CameraProjectorSurfaceStep,
  CameraProjectorSurfaceStepCopy,
  CameraProjectorSurfaceStorageKeys,
  LoadCameraProjectorSurfaceCalibrationOptions,
  SizeXY,
  SurfaceQuadDisplay,
} from './calibration.js';

export type {
  AppContext,
  AppEventsClient,
  AppEventsSubscription,
  AppLogger,
  DriverClient,
  DriverSubscription,
  ExperienceDefinition,
  ExperienceLifecycle,
  ExperienceRouter,
  ExperienceRuntimeContext,
  FrameInfo,
  ServerConnection,
  StorageClient,
  // re-exports from @gosai/shared
  AppCalibrationSchema,
  AppManifest,
  ExperienceDescriptor,
  PythonConfig,
  InstalledApp,
  RunningExperience,
  DriverInfo,
  DriverState,
  LogEntry,
  LogLevel,
  GlobalConfig,
  DisplayInfo,
  ExperienceState,
  AppState,
} from './types.js';

export { PROTOCOL_VERSION, ServerEvents, ClientCommands } from './types.js';

// Homography utilities for camera/projector calibration consumers.
export {
  perspectiveTransformPoint,
  perspectiveTransformPoints,
  invertHomography,
  quadToQuadHomography,
  computeCSSMatrix3d,
  multiplyHomographies,
} from './homography.js';
export type { Point2D, Quad } from './homography.js';
