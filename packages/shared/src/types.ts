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
  'available' | 'starting' | 'running' | 'paused' | 'stopping' | 'stopped' | 'errored';
export type AppState = 'installed' | 'starting' | 'running' | 'stopping' | 'crashed';

export interface DriverRuntimeInfo {
  readonly backend: string;
  readonly provider?: string;
  readonly device?: string;
  readonly device_id?: number;
  readonly model?: string;
  readonly accelerated: boolean;
  readonly available_providers?: readonly string[];
  readonly requested_providers?: readonly string[];
  readonly reason?: string;
}

export interface DriverInfo {
  readonly name: string;
  readonly description?: string;
  readonly state: DriverState;
  readonly events: readonly string[];
  readonly actions: readonly string[];
  readonly dependencies: readonly string[];
  readonly subscribers: readonly string[];
  /**
   * Sharing policy. `false` (default) means the driver is exclusive: each app
   * binding gets its own device-bound instance. `true` means the driver can be
   * shared across apps (e.g. speaker output, device-less utilities).
   */
  readonly shared: boolean;
  /** Runtime/backend information for the primary active instance, when known. */
  readonly runtime?: DriverRuntimeInfo;
  /** Running instances of this driver, keyed by binding/device. */
  readonly instances?: readonly DriverInstanceInfo[];
}

/** A single running instance of a driver, bound to an app and/or device. */
export interface DriverInstanceInfo {
  /** Namespace the instance lives in: an app slug (exclusive) or `shared`/`shared:dev<n>`. */
  readonly instance: string;
  readonly state: DriverState;
  readonly subscribers: readonly string[];
  readonly runtime?: DriverRuntimeInfo;
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
  /**
   * Device kinds this app needs. Drives the per-app device picker in the
   * dashboard. Omitted kinds default to `false`.
   */
  readonly requirements?: AppRequirements;
  /**
   * Declares whether this app owns a calibration flow. Calibration is explicit
   * per app; it is not inferred from camera/display requirements.
   */
  readonly calibration?: AppCalibrationSchema;
  /**
   * Declarative settings schema. When present, the dashboard renders an
   * editable settings form for the app; values are persisted to the app's
   * key/value storage under {@link AppSettingsSchema.storageKey} as a single
   * (possibly nested) JSON object, which the app reads via `rt.storage`.
   */
  readonly settings?: AppSettingsSchema;
}

/** Device kinds an app declares it needs, so the dashboard can offer pickers. */
export interface AppRequirements {
  readonly display?: boolean;
  readonly camera?: boolean;
  readonly microphone?: boolean;
  readonly speaker?: boolean;
}

/** Calibration capability declared by an app manifest. */
export interface AppCalibrationSchema {
  readonly required: boolean;
  /**
   * Browser ESM module, relative to the app root, exporting a calibration
   * definition. Required when `required` is true.
   */
  readonly entry?: string;
  /** Storage key used to mark calibration completion. Defaults to `calibration_status`. */
  readonly statusKey?: string;
}

/** Supported field input types for {@link AppSettingsField}. */
export type AppSettingsFieldType = 'boolean' | 'number' | 'string' | 'select';

/** A single editable setting. */
export interface AppSettingsField {
  /**
   * Dotted path into the stored config object (e.g. `"projection.mode"`).
   * Determines where the value is read/written within the storage object.
   */
  readonly key: string;
  readonly label: string;
  readonly type: AppSettingsFieldType;
  readonly description?: string;
  /** Default value, used when storage has no value for this key. */
  readonly default?: string | number | boolean;
  /** Options for `type: "select"`. */
  readonly options?: readonly AppSettingsOption[];
  /** Bounds/step for `type: "number"`. */
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
}

export interface AppSettingsOption {
  readonly value: string;
  readonly label: string;
}

/** A labelled group of related settings. */
export interface AppSettingsGroup {
  readonly label: string;
  readonly description?: string;
  readonly fields: readonly AppSettingsField[];
}

/** Declarative app settings schema (see {@link AppManifest.settings}). */
export interface AppSettingsSchema {
  /** Storage key the config object is persisted under. Defaults to `"config"`. */
  readonly storageKey?: string;
  readonly groups: readonly AppSettingsGroup[];
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

export interface CameraSettings {
  readonly device: number;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
}

/** One resolution and the frame rates that work at that size on the current device. */
export interface CameraFormat {
  readonly width: number;
  readonly height: number;
  readonly fps: readonly number[];
  readonly codecs?: readonly string[];
}

export interface CameraFormatsResult {
  readonly ok: boolean;
  readonly device: number;
  readonly formats?: readonly CameraFormat[];
  readonly error?: string;
}

export interface MicrophoneSettings {
  /** sounddevice input index, or null for the system default. */
  readonly device: number | null;
  readonly samplerate?: number;
  readonly channels?: number;
}

export interface SpeakerSettings {
  /** sounddevice output index, or null for the system default. */
  readonly device: number | null;
  readonly samplerate?: number;
}

export type DisplayMode = 'fullscreen' | 'windowed';

export interface AppDisplaySettings {
  /** Electron display id, or null to fall back to the global/primary display. */
  readonly id: number | null;
  readonly mode: DisplayMode;
}

/**
 * Per-application device assignments, persisted per app slug. Camera and
 * microphone are exclusive (each app binds its own device); speaker and display
 * may be shared across apps.
 */
export interface AppDeviceSettings {
  readonly display?: AppDisplaySettings;
  readonly camera?: CameraSettings;
  readonly microphone?: MicrophoneSettings;
  readonly speaker?: SpeakerSettings;
}

/**
 * Patch shape for updating per-app device settings. Each device block may be
 * partial; the store shallow-merges it over the existing block.
 */
export interface AppDeviceSettingsPatch {
  readonly display?: Partial<AppDisplaySettings>;
  readonly camera?: Partial<CameraSettings>;
  readonly microphone?: Partial<MicrophoneSettings>;
  readonly speaker?: Partial<SpeakerSettings>;
}

/** A single enumerated hardware device offered to the per-app device picker. */
export interface DeviceOption {
  readonly index: number;
  readonly label: string;
  readonly isDefault?: boolean;
}

export interface DeviceCatalog {
  readonly cameras: readonly DeviceOption[];
  readonly microphones: readonly DeviceOption[];
  readonly speakers: readonly DeviceOption[];
}

export interface GlobalConfig {
  readonly displayId: number | null;
  readonly serverPort: number;
  readonly autoStartApps: readonly string[];
  readonly camera: CameraSettings;
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
