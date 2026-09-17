/**
 * Zod schemas for the data the server reads from disk or the network: app
 * manifests, the global config, per-app device settings, and the shapes the
 * protocol carries. Each schema is annotated with the matching type from
 * `types.ts`, so the two can't drift apart.
 *
 * This module pulls in zod. Code that only needs types or constants (the
 * client, the SDK bundle) must not import it.
 */

import { z } from 'zod';
import { isConnectSource } from './app-origin.js';
import { isValidSettingKey } from './app-settings.js';
import {
  BUILTIN_CALIBRATION_KINDS,
  CALIBRATION_KIND_PATTERN,
  CALIBRATION_PROFILE_VERSION,
  isBuiltinCalibrationKind,
  upgradeLegacyCalibration,
  type AppCalibrationSchema,
  type BuiltinCalibrationKind,
  type CalibrationProfile,
  type CalibrationProfileInput,
  type CameraProjectorSurfaceCalibration,
  type CameraProjectorSurfaceOptions,
} from './calibration.js';
import { CAPABILITY_INFO, isCapability, type Capability } from './capabilities.js';
import { isSemverRange } from './semver-range.js';
import { isReservedSlug, isValidSlug, SLUG_PATTERN } from './slug.js';
import type {
  AppDeviceSettings,
  AppDeviceSettingsPatch,
  AppManifest,
  AppNetworkSchema,
  AppRequirements,
  AppSettingsField,
  AppSettingsSchema,
  CameraSettings,
  DeviceCatalog,
  DriverEventPayload,
  DriverInfo,
  DriverInstanceInfo,
  DriverRuntimeInfo,
  DriverSchema,
  DriverSchemasResult,
  ExperienceDescriptor,
  GlobalConfig,
  GlobalConfigPatch,
  InstalledApp,
  InvalidApp,
  LogEntry,
  PerformanceSample,
  PythonConfig,
  RunningExperience,
  SystemStats,
} from './types.js';

// ── Primitives ─────────────────────────────────────────────────────────────

export const slugSchema = z
  .string()
  .regex(SLUG_PATTERN, `must match ${SLUG_PATTERN.source}`)
  .refine(isValidSlug, 'is too long');

export const STORAGE_KEY_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

export const storageKeySchema = z
  .string()
  .regex(STORAGE_KEY_PATTERN, `must match ${STORAGE_KEY_PATTERN.source}`);

/** Python driver names, e.g. `hand_pose`. */
export const driverNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/, 'must be a driver name like hand_pose');

const nonEmpty = z.string().min(1);

/** A path relative to the app root that stays inside it. */
const appPathSchema = z
  .string()
  .min(1)
  .refine(
    (path) =>
      !path.startsWith('/') &&
      !path.includes('\\') &&
      !path.includes('\0') &&
      path.split('/').every((part) => part !== '..'),
    'must be a relative path inside the app',
  );

const logLevelSchema = z.enum(['debug', 'info', 'warn', 'error']);

// ── Manifest ───────────────────────────────────────────────────────────────

const experienceSchema = z.strictObject({
  slug: slugSchema,
  name: nonEmpty,
  description: z.string().optional(),
  entry: appPathSchema.describe(
    'ES module, relative to the app root, that default-exports the experience.',
  ),
  python: z.string().optional().describe('Reserved for app-provided Python drivers.'),
  drivers: z
    .array(driverNameSchema)
    .default([])
    .describe('Drivers kept running while the experience runs.'),
  exclusive: z
    .boolean()
    .default(false)
    .describe("Starting this experience stops the app's other experiences, except `allowed`."),
  allowed: z.array(slugSchema).optional(),
  required: z
    .array(slugSchema)
    .optional()
    .describe('Experiences that start first, with the same driver binding.'),
}) satisfies z.ZodType<ExperienceDescriptor>;

const pythonSchema = z.strictObject({
  requirements: appPathSchema.optional(),
  module: z.string().optional(),
}) satisfies z.ZodType<PythonConfig>;

const requirementsSchema = z.strictObject({
  display: z.boolean().optional(),
  camera: z.boolean().optional(),
  microphone: z.boolean().optional(),
  speaker: z.boolean().optional(),
}) satisfies z.ZodType<AppRequirements>;

// ── Calibration ────────────────────────────────────────────────────────────

const finite = z.number().refine(Number.isFinite, 'must be a finite number');
const positive = finite.refine((value) => value > 0, 'must be positive');

const calibrationPointSchema = z.object({ x: finite, y: finite });
const calibrationQuadSchema = z.tuple([
  calibrationPointSchema,
  calibrationPointSchema,
  calibrationPointSchema,
  calibrationPointSchema,
]);
const calibrationSizeSchema = z.object({ width: positive, height: positive });
/** A 3x3 matrix flattened row by row. */
const matrixSchema = z.array(finite).length(9);

export const calibrationKindSchema = z
  .string()
  .regex(CALIBRATION_KIND_PATTERN, `must match ${CALIBRATION_KIND_PATTERN.source}`);

const stepCopySchema = z.strictObject({
  title: z.string().optional(),
  help: z.string().optional(),
});

export const cameraProjectorSurfaceOptionsSchema = z.strictObject({
  surfaceSize: z.strictObject({ width: positive, height: positive }).optional(),
  cornerLabels: z.tuple([z.string(), z.string(), z.string(), z.string()]).optional(),
  stepCopy: z
    .strictObject({
      markers: stepCopySchema.optional(),
      'surface-corners': stepCopySchema.optional(),
      compute: stepCopySchema.optional(),
      preview: stepCopySchema.optional(),
    })
    .optional(),
  projectorMessages: z
    .strictObject({
      surfaceCorners: z.string().optional(),
      compute: z.string().optional(),
      done: z.string().optional(),
      cancelled: z.string().optional(),
    })
    .optional(),
}) satisfies z.ZodType<CameraProjectorSurfaceOptions>;

export const cameraProjectorSurfaceCalibrationSchema = z.object({
  homography: matrixSchema,
  homographyInverse: matrixSchema,
  homographySurface: matrixSchema.nullable(),
  homographySurfaceInverse: matrixSchema.nullable(),
  focusQuad: calibrationQuadSchema.nullable(),
  surfaceQuadDisplay: calibrationQuadSchema.nullable(),
  surfaceSize: calibrationSizeSchema,
  frameSize: calibrationSizeSchema.nullable(),
}) satisfies z.ZodType<CameraProjectorSurfaceCalibration>;

/** Options and profile data of each built-in kind. */
export const builtinCalibrationSchemas = {
  'camera-projector-surface': {
    options: cameraProjectorSurfaceOptionsSchema,
    data: cameraProjectorSurfaceCalibrationSchema,
  },
} satisfies Record<BuiltinCalibrationKind, { options: z.ZodType; data: z.ZodType }>;

const calibrationSchema = z
  .strictObject({
    kind: calibrationKindSchema.describe(
      `What the calibration produces: ${BUILTIN_CALIBRATION_KINDS.join(', ')}, or any kind an \`experience\` handles.`,
    ),
    required: z.boolean().default(false).describe('The app must be calibrated before it starts.'),
    options: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('Settings of the calibration flow, checked for built-in kinds.'),
    experience: slugSchema
      .optional()
      .describe("One of the app's experiences that runs a custom calibration flow."),
  })
  .superRefine((calibration, ctx) => {
    if (!isBuiltinCalibrationKind(calibration.kind)) {
      if (calibration.experience === undefined) {
        ctx.addIssue({
          code: 'custom',
          message: `"${calibration.kind}" is not a built-in kind (${BUILTIN_CALIBRATION_KINDS.join(', ')}), so \`experience\` must name the experience that runs it`,
          path: ['experience'],
        });
      }
      return;
    }
    const options = builtinCalibrationSchemas[calibration.kind].options.safeParse(
      calibration.options ?? {},
    );
    for (const issue of options.error?.issues ?? []) {
      ctx.addIssue({ code: 'custom', message: issue.message, path: ['options', ...issue.path] });
    }
  }) satisfies z.ZodType<AppCalibrationSchema>;

/** What `calibration:save` accepts. Built-in kinds' data is checked against the manifest. */
export const calibrationProfileInputSchema = z.strictObject({
  kind: calibrationKindSchema,
  data: z.unknown(),
}) satisfies z.ZodType<CalibrationProfileInput>;

export const calibrationProfileSchema = z.object({
  version: z.literal(CALIBRATION_PROFILE_VERSION),
  kind: calibrationKindSchema,
  savedAt: z.number(),
  data: z.unknown(),
}) satisfies z.ZodType<CalibrationProfile>;

/**
 * Checks profile data: against the kind's schema for built-in kinds, as any
 * JSON value for custom ones. Returns the parsed data or an error message.
 */
export function parseCalibrationData(
  kind: string,
  data: unknown,
): { success: true; data: unknown } | { success: false; error: string } {
  if (!isBuiltinCalibrationKind(kind)) {
    return data === undefined
      ? { success: false, error: 'data is missing' }
      : { success: true, data };
  }
  const result = builtinCalibrationSchemas[kind].data.safeParse(data);
  return result.success
    ? { success: true, data: result.data }
    : { success: false, error: formatZodError(result.error) };
}

const settingKeySchema = z
  .string()
  .refine(isValidSettingKey, 'must be a dotted path such as projection.mode');

const fieldBase = {
  key: settingKeySchema,
  label: nonEmpty,
  description: z.string().optional(),
};

const selectOptionSchema = z.strictObject({ value: z.string(), label: z.string() });

const settingsFieldSchema = z
  .discriminatedUnion('type', [
    z.strictObject({ ...fieldBase, type: z.literal('boolean'), default: z.boolean().optional() }),
    z.strictObject({ ...fieldBase, type: z.literal('string'), default: z.string().optional() }),
    z.strictObject({
      ...fieldBase,
      type: z.literal('number'),
      default: z.number().optional(),
      min: z.number().optional(),
      max: z.number().optional(),
      step: z.number().positive().optional(),
    }),
    z.strictObject({
      ...fieldBase,
      type: z.literal('select'),
      default: z.string().optional(),
      options: z.array(selectOptionSchema).min(1),
    }),
  ])
  .superRefine((field, ctx) => {
    if (field.type === 'number') {
      if (field.min !== undefined && field.max !== undefined && field.min > field.max) {
        ctx.addIssue({ code: 'custom', message: '`min` is greater than `max`', path: ['min'] });
      }
      if (field.default !== undefined && !numberInRange(field, field.default)) {
        ctx.addIssue({ code: 'custom', message: 'default is out of range', path: ['default'] });
      }
    }
    if (
      field.type === 'select' &&
      field.default !== undefined &&
      !field.options.some((option) => option.value === field.default)
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'default is not one of the options',
        path: ['default'],
      });
    }
  }) satisfies z.ZodType<AppSettingsField>;

const settingsSchema = z
  .strictObject({
    storageKey: storageKeySchema.optional(),
    groups: z.array(
      z.strictObject({
        label: nonEmpty,
        description: z.string().optional(),
        fields: z.array(settingsFieldSchema),
      }),
    ),
  })
  .superRefine((settings, ctx) => {
    const seen = new Set<string>();
    settings.groups.forEach((group, groupIndex) => {
      group.fields.forEach((field, fieldIndex) => {
        if (seen.has(field.key)) {
          ctx.addIssue({
            code: 'custom',
            message: `duplicate setting key "${field.key}"`,
            path: ['groups', groupIndex, 'fields', fieldIndex, 'key'],
          });
        }
        seen.add(field.key);
      });
    });
  }) satisfies z.ZodType<AppSettingsSchema>;

const requestableCapabilitySchema = z
  .string()
  .refine(isCapability, 'unknown capability')
  .refine(
    (value) => !isCapability(value) || CAPABILITY_INFO[value].grant !== 'dashboard',
    'only the dashboard has this capability',
  )
  .transform((value) => value as Capability)
  .meta({
    enum: Object.entries(CAPABILITY_INFO)
      .filter(([, info]) => info.grant !== 'dashboard')
      .map(([name]) => name),
  });

const networkSchema = z.strictObject({
  connect: z
    .array(
      z
        .string()
        .refine(
          isConnectSource,
          'must be scheme://host[:port] with an http, https, ws or wss scheme and no path',
        ),
    )
    .optional(),
}) satisfies z.ZodType<AppNetworkSchema>;

/**
 * The `gosai.app.json` schema. `$schema` is accepted so editors can validate.
 * Unknown top-level fields are dropped rather than rejected, so a manifest
 * with an extra `homepage` or an old `builtin` still loads;
 * `parseAppManifest` reports them as warnings.
 */
export const appManifestSchema = z
  .object({
    $schema: z.string().optional(),
    builtin: z
      .boolean()
      .optional()
      .describe('Ignored. Whether an app is built in depends on where it is installed.'),
    slug: slugSchema
      .refine((slug) => !isReservedSlug(slug), 'is reserved')
      .describe('Unique app id. Names its directory and driver binding.'),
    name: nonEmpty.describe('Display name.'),
    version: nonEmpty,
    sdk: z
      .string()
      .refine(isSemverRange, 'must be a semver range such as ^0.1.0')
      .optional()
      .describe(
        'Versions of @gosai/sdk the app works with, as a semver range such as ^0.1.0. GOSAI refuses to install or list the app when its SDK is outside the range.',
      ),
    description: z.string().optional(),
    author: z.string().optional().describe('Shown by the dashboard.'),
    icon: appPathSchema
      .optional()
      .describe('Image shown by the dashboard, relative to the app root.'),
    experiences: z.array(experienceSchema).min(1),
    default: slugSchema
      .optional()
      .describe("Experience the dashboard's primary button starts. Defaults to the first."),
    python: pythonSchema.optional().describe('Reserved for app-provided Python drivers.'),
    startup: z
      .array(slugSchema)
      .optional()
      .describe(
        'Experiences started at server boot when the app is in the global autoStartApps. Defaults to the default experience.',
      ),
    capabilities: z
      .array(requestableCapabilitySchema)
      .optional()
      .describe('Capabilities the app needs beyond the defaults. Shown at install.'),
    network: networkSchema
      .optional()
      .describe(
        "External origins the app connects to. Shown at install and added to the page's CSP.",
      ),
    requirements: requirementsSchema
      .optional()
      .describe('Device kinds the app uses, for the per-app device pickers.'),
    calibration: calibrationSchema
      .optional()
      .describe('How the app is calibrated, when it needs calibration.'),
    settings: settingsSchema
      .optional()
      .describe('Settings the dashboard edits, stored as one object in app storage.'),
  })
  .superRefine((manifest, ctx) => {
    const slugs = manifest.experiences.map((experience) => experience.slug);
    const known = new Set(slugs);
    slugs.forEach((slug, index) => {
      if (slugs.indexOf(slug) !== index) {
        ctx.addIssue({
          code: 'custom',
          message: `duplicate experience slug "${slug}"`,
          path: ['experiences', index, 'slug'],
        });
      }
    });
    const checkRefs = (refs: readonly string[] | undefined, path: (string | number)[]): void => {
      refs?.forEach((ref, index) => {
        if (!known.has(ref)) {
          ctx.addIssue({
            code: 'custom',
            message: `"${ref}" does not match any experience slug`,
            path: [...path, index],
          });
        }
      });
    };
    if (manifest.default !== undefined && !known.has(manifest.default)) {
      ctx.addIssue({
        code: 'custom',
        message: `"${manifest.default}" does not match any experience slug`,
        path: ['default'],
      });
    }
    checkRefs(manifest.startup, ['startup']);
    const calibrationExperience = manifest.calibration?.experience;
    if (calibrationExperience !== undefined && !known.has(calibrationExperience)) {
      ctx.addIssue({
        code: 'custom',
        message: `"${calibrationExperience}" does not match any experience slug`,
        path: ['calibration', 'experience'],
      });
    }
    manifest.experiences.forEach((experience, index) => {
      checkRefs(experience.allowed, ['experiences', index, 'allowed']);
      checkRefs(experience.required, ['experiences', index, 'required']);
    });
    const cycle = findRequiredCycle(manifest.experiences);
    if (cycle) {
      ctx.addIssue({
        code: 'custom',
        message: `experiences require each other in a cycle: ${cycle.join(' -> ')}`,
        path: ['experiences'],
      });
    }
  });

/**
 * Parsed manifest, without `$schema`. A `calibration` object in its
 * pre-kind shape is converted first (see `upgradeLegacyCalibration`), with a
 * warning, so older apps keep working; the schema itself only describes the
 * current shape.
 */
export function parseAppManifest(
  value: unknown,
):
  | { success: true; data: AppManifest; warnings: readonly string[] }
  | { success: false; error: string } {
  const upgraded = upgradeLegacyManifest(value);
  const result = appManifestSchema.safeParse(upgraded.value);
  if (!result.success) return { success: false, error: formatZodError(result.error) };
  const { $schema: _schema, builtin, ...manifest } = result.data;
  const warnings: string[] = [...upgraded.warnings];
  if (builtin !== undefined) {
    warnings.push('`builtin` is ignored; it comes from where the app is installed');
  }
  const known = new Set(Object.keys(appManifestSchema.shape));
  for (const key of Object.keys(value as object)) {
    if (!known.has(key)) warnings.push(`unknown field \`${key}\` is ignored`);
  }
  return { success: true, data: manifest satisfies AppManifest, warnings };
}

function upgradeLegacyManifest(value: unknown): {
  value: unknown;
  warnings: readonly string[];
} {
  if (typeof value !== 'object' || value === null || !('calibration' in value)) {
    return { value, warnings: [] };
  }
  const { calibration, ...rest } = value as Record<string, unknown>;
  const upgraded = upgradeLegacyCalibration(calibration);
  if (upgraded.warnings.length === 0) return { value, warnings: [] };
  return {
    value:
      upgraded.calibration === undefined ? rest : { ...rest, calibration: upgraded.calibration },
    warnings: upgraded.warnings,
  };
}

/** The first `required` cycle among experiences, as a slug path, or `null`. */
export function findRequiredCycle(
  experiences: readonly Pick<ExperienceDescriptor, 'slug' | 'required'>[],
): string[] | null {
  const requires = new Map(experiences.map((e) => [e.slug, e.required ?? []]));
  const done = new Set<string>();
  const visit = (slug: string, path: string[]): string[] | null => {
    const start = path.indexOf(slug);
    if (start !== -1) return [...path.slice(start), slug];
    if (done.has(slug)) return null;
    for (const next of requires.get(slug) ?? []) {
      const cycle = visit(next, [...path, slug]);
      if (cycle) return cycle;
    }
    done.add(slug);
    return null;
  };
  for (const experience of experiences) {
    const cycle = visit(experience.slug, []);
    if (cycle) return cycle;
  }
  return null;
}

function numberInRange(field: { min?: number; max?: number }, value: number): boolean {
  return (
    Number.isFinite(value) &&
    (field.min === undefined || value >= field.min) &&
    (field.max === undefined || value <= field.max)
  );
}

// ── Devices and config ─────────────────────────────────────────────────────

const deviceIndexSchema = z.number().int().min(0);
const positiveInt = z.number().int().positive();
const rotationSchema = z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]);

const cameraSettingsObject = z.strictObject({
  device: deviceIndexSchema,
  width: positiveInt,
  height: positiveInt,
  fps: z.number().positive(),
  rotation: rotationSchema.optional(),
}) satisfies z.ZodType<CameraSettings>;

export const cameraSettingsSchema: z.ZodType<CameraSettings> = cameraSettingsObject;

export const DEFAULT_CAMERA_SETTINGS: CameraSettings = {
  device: 0,
  width: 1280,
  height: 720,
  fps: 30,
};

export const DEFAULT_GLOBAL_CONFIG: GlobalConfig = {
  displayId: null,
  serverPort: 7777,
  autoStartApps: [],
  camera: DEFAULT_CAMERA_SETTINGS,
};

const portSchema = z.number().int().min(0).max(65535);

/**
 * The stored `global.json`. Missing fields take their defaults; unknown
 * fields are dropped.
 */
export const globalConfigFileSchema: z.ZodType<GlobalConfig> = z.object({
  displayId: z.number().int().nullable().default(DEFAULT_GLOBAL_CONFIG.displayId),
  serverPort: portSchema.default(DEFAULT_GLOBAL_CONFIG.serverPort),
  autoStartApps: z.array(slugSchema).default([]),
  camera: z
    .object({
      device: deviceIndexSchema.default(DEFAULT_CAMERA_SETTINGS.device),
      width: positiveInt.default(DEFAULT_CAMERA_SETTINGS.width),
      height: positiveInt.default(DEFAULT_CAMERA_SETTINGS.height),
      fps: z.number().positive().default(DEFAULT_CAMERA_SETTINGS.fps),
      rotation: rotationSchema.optional(),
    })
    .default(DEFAULT_CAMERA_SETTINGS),
});

export const globalConfigSchema: z.ZodType<GlobalConfig> = z.strictObject({
  displayId: z.number().int().nullable(),
  serverPort: portSchema,
  autoStartApps: z.array(slugSchema),
  camera: cameraSettingsObject,
});

export const globalConfigPatchSchema: z.ZodType<GlobalConfigPatch, GlobalConfigPatch> =
  z.strictObject({
    displayId: z.number().int().nullable().optional(),
    serverPort: portSchema.optional(),
    autoStartApps: z.array(slugSchema).optional(),
    camera: cameraSettingsObject.partial().optional(),
  });

const displaySettingsFields = {
  id: z.number().int().nullable(),
  mode: z.enum(['fullscreen', 'windowed']),
};
const microphoneFields = {
  device: deviceIndexSchema.nullable(),
  samplerate: positiveInt,
  channels: positiveInt,
};
const speakerFields = {
  device: deviceIndexSchema.nullable(),
  samplerate: positiveInt,
};

/** Stored per-app device settings. Every field is an optional override. */
export const appDeviceSettingsSchema: z.ZodType<AppDeviceSettings> = z.object({
  display: z.strictObject(displaySettingsFields).partial().optional(),
  camera: cameraSettingsObject.partial().optional(),
  microphone: z.strictObject(microphoneFields).partial().optional(),
  speaker: z.strictObject(speakerFields).partial().optional(),
});

function clearable<T extends Record<string, z.ZodType>>(shape: T) {
  const fields = Object.fromEntries(
    Object.entries(shape).map(([key, schema]) => [key, schema.nullable().optional()]),
  ) as { [K in keyof T]: z.ZodOptional<z.ZodNullable<T[K]>> };
  return z.strictObject(fields).nullable().optional();
}

export const appDeviceSettingsPatchSchema: z.ZodType<
  AppDeviceSettingsPatch,
  AppDeviceSettingsPatch
> = z.strictObject({
  display: clearable(displaySettingsFields),
  camera: clearable(cameraSettingsObject.shape),
  microphone: clearable(microphoneFields),
  speaker: clearable(speakerFields),
});

// ── Protocol payloads ──────────────────────────────────────────────────────

const deviceOptionSchema = z.object({
  index: z.number().int(),
  label: z.string(),
  isDefault: z.boolean().optional(),
});

export const deviceCatalogSchema: z.ZodType<DeviceCatalog> = z.object({
  cameras: z.array(deviceOptionSchema),
  microphones: z.array(deviceOptionSchema),
  speakers: z.array(deviceOptionSchema),
});

export const logEntrySchema: z.ZodType<LogEntry> = z.object({
  timestamp: z.number(),
  level: logLevelSchema,
  source: z.string(),
  message: z.string(),
  data: z.record(z.string(), z.unknown()).optional(),
});

export { logLevelSchema };

const driverStateSchema = z.enum([
  'available',
  'starting',
  'running',
  'paused',
  'stopping',
  'stopped',
  'errored',
]);

const driverRuntimeSchema = z.object({
  backend: z.string(),
  provider: z.string().optional(),
  device: z.string().optional(),
  device_id: z.number().optional(),
  model: z.string().optional(),
  accelerated: z.boolean(),
  available_providers: z.array(z.string()).optional(),
  requested_providers: z.array(z.string()).optional(),
  reason: z.string().optional(),
}) satisfies z.ZodType<DriverRuntimeInfo>;

const driverInstanceSchema = z.object({
  instance: z.string(),
  state: driverStateSchema,
  subscribers: z.array(z.string()),
  runtime: driverRuntimeSchema.optional(),
}) satisfies z.ZodType<DriverInstanceInfo>;

export const driverInfoSchema: z.ZodType<DriverInfo> = z.object({
  name: z.string(),
  description: z.string().optional(),
  state: driverStateSchema,
  events: z.array(z.string()),
  actions: z.array(z.string()),
  dependencies: z.array(z.string()),
  subscribers: z.array(z.string()),
  shared: z.boolean(),
  runtime: driverRuntimeSchema.optional(),
  instances: z.array(driverInstanceSchema).optional(),
  schemaVersion: z.string().optional(),
});

export const driverEventPayloadSchema: z.ZodType<DriverEventPayload> = z.object({
  driver: z.string(),
  event: z.string(),
  data: z.unknown(),
  ts: z.number(),
  binding: z.string(),
});

/**
 * A driver's schema, as the Python bridge describes it. The bridge owns its
 * shape (see `DriverSchema`), so the protocol passes it through as JSON.
 */
export const driverSchemasResultSchema: z.ZodType<DriverSchemasResult> = z.object({
  schemas: z.record(
    z.string(),
    z.object({
      schemaVersion: z.string().nullable(),
      schema: z
        .custom<DriverSchema>((value) => typeof value === 'object' && value !== null)
        .nullable(),
    }),
  ),
});

export const installedAppSchema: z.ZodType<InstalledApp> = z.object({
  manifest: z.custom<AppManifest>((value) => appManifestSchema.safeParse(value).success),
  installedAt: z.number(),
  source: z.enum(['builtin', 'git']),
  builtin: z.boolean(),
  grantedCapabilities: z.array(z.custom<Capability>(isCapability)),
  state: z.enum(['installed', 'starting', 'running', 'stopping', 'crashed']),
});

export const invalidAppSchema: z.ZodType<InvalidApp> = z.object({
  slug: z.string(),
  builtin: z.boolean(),
  error: z.string(),
});

export const runningExperienceSchema: z.ZodType<RunningExperience> = z.object({
  appSlug: z.string(),
  experienceSlug: z.string(),
  state: z.enum(['idle', 'starting', 'running', 'stopping', 'crashed']),
  startedAt: z.number(),
  startedAs: z.enum(['request', 'requirement']),
});

export const performanceSampleSchema: z.ZodType<PerformanceSample> = z.object({
  source: z.string(),
  instance: z.string().optional(),
  type: z.enum(['driver', 'experience', 'app', 'system']),
  metric: z.string(),
  value: z.number(),
  timestamp: z.number(),
});

export const systemStatsSchema: z.ZodType<SystemStats> = z.object({
  cpuPercent: z.number(),
  memoryBytes: z.number(),
  memoryTotalBytes: z.number(),
  uptimeMs: z.number(),
});

// ── Errors ─────────────────────────────────────────────────────────────────

/** One line per issue, each prefixed with its path. */
export function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.map(String).join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join('; ');
}
