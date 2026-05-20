/**
 * Core type definitions shared across all GOSAI packages.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  readonly timestamp: number;
  readonly level: LogLevel;
  readonly source: string;
  readonly message: string;
  readonly data?: Record<string, unknown>;
}

export type ExperienceState = 'idle' | 'starting' | 'running' | 'stopping' | 'crashed';
export type DriverState =
  | 'available'
  | 'starting'
  | 'running'
  | 'paused'
  | 'stopping'
  | 'stopped'
  | 'errored';
export type AppState = 'installed' | 'starting' | 'running' | 'stopping' | 'crashed';

export interface DriverInfo {
  readonly name: string;
  readonly description?: string;
  readonly state: DriverState;
  readonly events: readonly string[];
  readonly actions: readonly string[];
  readonly dependencies: readonly string[];
  readonly subscribers: readonly string[];
}

export interface ExperienceDescriptor {
  readonly slug: string;
  readonly name: string;
  readonly description?: string;
  readonly entry: string;
  readonly python?: string;
  readonly drivers: readonly string[];
  readonly exclusive: boolean;
  readonly allowed?: readonly string[];
  readonly required?: readonly string[];
}

export interface PythonConfig {
  readonly requirements?: string;
  readonly module?: string;
}

export interface AppManifest {
  readonly slug: string;
  readonly name: string;
  readonly description?: string;
  readonly version: string;
  readonly author?: string;
  readonly icon?: string;
  readonly experiences: readonly ExperienceDescriptor[];
  /**
   * Slug of the experience to launch when the user clicks the app card's
   * primary button. If omitted, the first experience in `experiences` is
   * used. Must reference an existing experience slug.
   */
  readonly default?: string;
  readonly python?: PythonConfig;
  readonly startup?: readonly string[];
  readonly builtin?: boolean;
}

export interface InstalledApp {
  readonly manifest: AppManifest;
  readonly installPath: string;
  readonly installedAt: number;
  readonly source: string;
  readonly state: AppState;
}

export interface RunningExperience {
  readonly appSlug: string;
  readonly experienceSlug: string;
  readonly state: ExperienceState;
  readonly startedAt: number;
  readonly pid?: number;
}

export interface DisplayInfo {
  readonly id: number;
  readonly label: string;
  readonly bounds: { x: number; y: number; width: number; height: number };
  readonly workArea: { x: number; y: number; width: number; height: number };
  readonly scaleFactor: number;
  readonly primary: boolean;
  readonly internal: boolean;
}

export interface GlobalConfig {
  readonly displayId: number | null;
  readonly serverPort: number;
  readonly autoStartApps: readonly string[];
}

export interface PerformanceSample {
  readonly source: string;
  readonly type: 'driver' | 'experience' | 'app' | 'system';
  readonly metric: string;
  readonly value: number;
  readonly timestamp: number;
}

export interface SystemStats {
  readonly cpuPercent: number;
  readonly memoryBytes: number;
  readonly memoryTotalBytes: number;
  readonly uptimeMs: number;
}
