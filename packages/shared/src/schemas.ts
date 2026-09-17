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
import { isValidSettingKey } from './app-settings.js';
import { CAPABILITY_INFO, isCapability, type Capability } from './capabilities.js';
import { isValidSlug, SLUG_PATTERN } from './slug.js';
import type {
  AppCalibrationSchema,
  AppDeviceSettings,
  AppDeviceSettingsPatch,
  AppManifest,
  AppNetwork,
  AppRequirements,
  AppSettingsField,
  AppSettingsSchema,
  CameraSettings,
  DeviceCatalog,
  DriverEventPayload,
  DriverInfo,
  DriverInstanceInfo,
  DriverRuntimeInfo,
  ExperienceDescriptor,
  GlobalConfig,
  GlobalConfigPatch,
  InstalledApp,
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

const calibrationSchema = z
  .strictObject({
    required: z.boolean(),
    entry: appPathSchema.optional(),
    statusKey: storageKeySchema.optional(),
  })
  .refine((c) => !c.required || c.entry !== undefined, {
    message: '`entry` is required when `required` is true',
    path: ['entry'],
  }) satisfies z.ZodType<AppCalibrationSchema>;

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

/**
 * `scheme://host[:port]` with scheme http, https, ws or wss. No path, and
 * nothing that could break out of a CSP source list: no quotes, `;`, `*` or
 * spaces.
 */
export const NETWORK_ORIGIN_PATTERN =
  /^(?:https?|wss?):\/\/(?:[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/;

const networkSchema = z.strictObject({
  connect: z
    .array(
      z
        .string()
        .regex(NETWORK_ORIGIN_PATTERN, 'must be scheme://host[:port] with http, https, ws or wss'),
    )
    .optional(),
}) satisfies z.ZodType<AppNetwork>;

/** The `gosai.app.json` schema. `$schema` is accepted so editors can validate. */
export const appManifestSchema = z
  .strictObject({
    $schema: z.string().optional(),
    slug: slugSchema.describe('Unique app id. Names its directory and driver binding.'),
    name: nonEmpty.describe('Display name.'),
    version: nonEmpty,
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
    calibration: calibrationSchema.optional(),
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

/** Parsed manifest, without `$schema`. */
export function parseAppManifest(
  value: unknown,
): { success: true; data: AppManifest } | { success: false; error: string } {
  const result = appManifestSchema.safeParse(value);
  if (!result.success) return { success: false, error: formatZodError(result.error) };
  const { $schema: _schema, ...manifest } = result.data;
  return { success: true, data: manifest satisfies AppManifest };
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
});

export const driverEventPayloadSchema: z.ZodType<DriverEventPayload> = z.object({
  driver: z.string(),
  event: z.string(),
  data: z.unknown(),
  ts: z.number(),
  binding: z.string(),
});

export const installedAppSchema: z.ZodType<InstalledApp> = z.object({
  manifest: z.custom<AppManifest>((value) => appManifestSchema.safeParse(value).success),
  installedAt: z.number(),
  source: z.enum(['builtin', 'git']),
  builtin: z.boolean(),
  state: z.enum(['installed', 'starting', 'running', 'stopping', 'crashed']),
});

export const runningExperienceSchema: z.ZodType<RunningExperience> = z.object({
  appSlug: z.string(),
  experienceSlug: z.string(),
  state: z.enum(['idle', 'starting', 'running', 'stopping', 'crashed']),
  startedAt: z.number(),
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
