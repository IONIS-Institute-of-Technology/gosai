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

export type {
  DriverAction,
  DriverActionArgs,
  DriverActionParams,
  DriverActionResult,
  DriverEvent,
  DriverEventData,
  DriverName,
  DriverRegistry,
  DriverTypes,
  KnownDriverName,
} from './driver-types.js';

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
  BUILTIN_CALIBRATION_KINDS,
  CALIBRATION_PROFILE_KEY,
  CALIBRATION_PROFILE_VERSION,
  CALIBRATION_RUNNER,
  CalibrationKinds,
  CalibrationParams,
  CalibrationWizardTopics,
  DEFAULT_SURFACE_SIZE,
  calibrationFlow,
  finishCalibration,
  isBuiltinCalibrationKind,
  isCalibrated,
  loadCalibrationProfile,
  loadCameraProjectorSurfaceCalibration,
  readCalibrationLaunch,
  saveCalibrationProfile,
  saveCameraProjectorSurfaceCalibration,
} from './calibration.js';
export type {
  BuiltinCalibrationKind,
  CalibrationLaunch,
  CalibrationPoint,
  CalibrationProfile,
  CalibrationProfileInput,
  CalibrationProfileOptions,
  CalibrationQuad,
  CalibrationResult,
  CalibrationRole,
  CalibrationRuntime,
  CalibrationSize,
  CameraProjectorSurfaceCalibration,
  CameraProjectorSurfaceOptions,
  CameraProjectorSurfaceStep,
  CameraProjectorSurfaceStepCopy,
  LoadCalibrationProfileOptions,
} from './calibration.js';
