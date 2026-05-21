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

export { createCanvas, fitCanvas, fullscreenContainer } from './renderer.js';
export type { CanvasOptions } from './renderer.js';

export { ServerClient } from './connection.js';
export type { ConnectionStatus } from './connection.js';

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

// Homography utilities for camera/projector calibration consumers. Re-exported
// from @gosai/shared so apps only need to depend on @gosai/sdk.
export {
  perspectiveTransformPoint,
  perspectiveTransformPoints,
  invertHomography,
  quadToQuadHomography,
  computeCSSMatrix3d,
  multiplyHomographies,
} from '@gosai/shared/homography';
export type { Point2D, Quad } from '@gosai/shared/homography';
