/**
 * @gosai/sdk - everything an app needs to build experiences on GOSAI.
 *
 * Code that hosts experiences (the app host page, test harnesses) imports
 * `@gosai/sdk/host`.
 */

export { defineExperience } from './experience.js';
export { SDK_VERSION } from './version.js';
export type {
  AppConfigClient,
  AppContext,
  AppEventsClient,
  AppEventsSubscription,
  AppLogger,
  AssetsClient,
  DriverClient,
  DriverSubscription,
  ExperienceContext,
  ExperienceDefinition,
  ExperienceRouter,
  ExperienceRuntimeContext,
  FrameInfo,
  ServerConnection,
  SettingsClient,
  StorageClient,
  // Manifest and server state shapes apps read.
  AppCalibrationSchema,
  AppDeviceSettings,
  AppManifest,
  AppRequirements,
  AppSettingsField,
  AppSettingsFieldType,
  AppSettingsGroup,
  AppSettingsOption,
  AppSettingsSchema,
  AppState,
  DriverInfo,
  DriverInstanceInfo,
  DriverRuntimeInfo,
  DriverState,
  ExperienceDescriptor,
  ExperienceState,
  InstalledApp,
  LogLevel,
  PythonConfig,
  RunningExperience,
} from './types.js';

export { createStorageClient } from './storage.js';

// Errors `rt.drivers`, `rt.storage` and `rt.app.server` requests reject with.
export {
  ConnectionClosedError,
  isNotConnectedError,
  NotConnectedError,
  RequestTimeoutError,
  ServerRequestError,
} from '@gosai/shared/client';
export { ErrorCodes, PROTOCOL_VERSION } from '@gosai/shared/protocol';
export type {
  CommandName,
  CommandRequest,
  CommandResponse,
  ErrorCode,
  ErrorPayload,
  EventPayload,
  WelcomePayload,
} from '@gosai/shared/protocol';
export type { Capability } from '@gosai/shared/capabilities';
export type { ServerEventName } from '@gosai/shared/events';

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

export {
  computeCSSMatrix3d,
  invertHomography,
  multiplyHomographies,
  perspectiveTransformPoint,
  perspectiveTransformPoints,
  quadToQuadHomography,
} from './homography.js';
export type { Point2D, Quad } from './homography.js';

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
