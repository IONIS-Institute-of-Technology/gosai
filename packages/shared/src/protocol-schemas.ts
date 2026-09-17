/**
 * Zod schemas for every command's request and response and every event's
 * payload. The server validates requests with them; the types in
 * `protocol.ts` are derived from them.
 *
 * This module pulls in zod. The client and the SDK bundle import its types
 * only.
 */

import { z } from 'zod';
import { isCapability } from './capabilities.js';
import {
  calibrationProfileInputSchema,
  calibrationProfileSchema,
  appDeviceSettingsPatchSchema,
  appDeviceSettingsSchema,
  deviceCatalogSchema,
  driverEventPayloadSchema,
  driverInfoSchema,
  driverSchemasResultSchema,
  globalConfigPatchSchema,
  globalConfigSchema,
  installedAppSchema,
  invalidAppSchema,
  logEntrySchema,
  logLevelSchema,
  performanceSampleSchema,
  runningExperienceSchema,
  slugSchema,
  storageKeySchema,
  systemStatsSchema,
} from './schemas.js';
import type { Capability } from './capabilities.js';
import type { AppSettingsValues } from './types.js';

const empty = z.strictObject({});
const capabilitySchema = z.custom<Capability>(isCapability, 'unknown capability');
const ok = z.object({ ok: z.literal(true) });
const text = z.string().min(1).max(256);
const settingsValues = z.record(z.string(), z.unknown()) as z.ZodType<AppSettingsValues>;

const driverTarget = {
  driver: text,
  /** App binding whose driver instance to use. Omitted means `system`, the dashboard's. */
  binding: slugSchema.optional(),
};

export const commandSchemas = {
  subscribe: {
    request: z.strictObject({ events: z.array(text).max(256) }),
    response: ok,
  },
  unsubscribe: {
    request: z.strictObject({ events: z.array(text).max(256) }),
    response: ok,
  },
  /** Round trip for latency meters. */
  'system:ping': {
    request: empty,
    response: z.object({ ts: z.number() }),
  },

  'apps:list': {
    request: empty,
    /** `invalid` lists app directories whose manifest doesn't parse. */
    response: z.object({ apps: z.array(installedAppSchema), invalid: z.array(invalidAppSchema) }),
  },
  'app:install': {
    request: z.strictObject({
      source: z.string().min(1).max(2048),
      /** Requested capabilities the operator approved. The rest stay ungranted. */
      capabilities: z.array(capabilitySchema).optional(),
      /** Keep data an earlier app with this slug left, even from another source. */
      reuseData: z.boolean().optional(),
    }),
    response: installedAppSchema,
  },
  'app:capabilities:set': {
    request: z.strictObject({ appSlug: slugSchema, capabilities: z.array(capabilitySchema) }),
    response: installedAppSchema,
  },
  'app:uninstall': {
    request: z.strictObject({
      slug: slugSchema,
      /** Also delete the app's storage and settings. Kept by default. */
      deleteData: z.boolean().optional(),
    }),
    response: z.object({ slug: z.string(), dataDeleted: z.boolean() }),
  },
  'app:broadcast': {
    request: z.strictObject({ appSlug: slugSchema, topic: text, data: z.unknown().optional() }),
    response: ok,
  },
  'app:log': {
    request: z.strictObject({
      source: text,
      level: logLevelSchema.optional(),
      message: z.string().max(64_000),
      data: z.record(z.string(), z.unknown()).nullable().optional(),
    }),
    response: ok,
  },
  'app:settings:get': {
    request: z.strictObject({ appSlug: slugSchema }),
    response: settingsValues,
  },
  'app:settings:set': {
    request: z.strictObject({
      appSlug: slugSchema,
      /** Declared field keys to values. `null` restores a field's default. */
      values: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
    }),
    response: settingsValues,
  },
  'app:config:get': {
    request: z.strictObject({ appSlug: slugSchema }),
    response: appDeviceSettingsSchema,
  },
  'app:config:set': {
    request: z.strictObject({ appSlug: slugSchema, settings: appDeviceSettingsPatchSchema }),
    response: appDeviceSettingsSchema,
  },

  'experiences:list': {
    request: empty,
    response: z.object({ experiences: z.array(runningExperienceSchema) }),
  },
  'experience:start': {
    request: z.strictObject({
      appSlug: slugSchema,
      experienceSlug: slugSchema,
      driverBinding: slugSchema.optional(),
    }),
    response: runningExperienceSchema,
  },
  'experience:stop': {
    request: z.strictObject({ appSlug: slugSchema, experienceSlug: slugSchema }),
    response: ok,
  },

  'drivers:list': {
    request: empty,
    response: z.object({ drivers: z.array(driverInfoSchema) }),
  },
  'drivers:schema': {
    /** Omit `driver` for every driver's schema. */
    request: z.strictObject({ driver: text.optional() }),
    response: driverSchemasResultSchema,
  },
  'devices:list': {
    request: empty,
    response: deviceCatalogSchema,
  },
  'driver:get-data': {
    request: z.strictObject({ ...driverTarget, event: text }),
    response: z.unknown(),
  },
  'driver:execute': {
    request: z.strictObject({ ...driverTarget, action: text, data: z.unknown().optional() }),
    response: z.unknown(),
  },
  'driver:subscribe': {
    request: z.strictObject({ ...driverTarget, event: text }),
    response: ok,
  },
  'driver:unsubscribe': {
    request: z.strictObject({ ...driverTarget, event: text }),
    response: ok,
  },

  'logs:history': {
    request: z.strictObject({
      limit: z.number().int().positive().optional(),
      /** Minimum level. */
      level: logLevelSchema.optional(),
    }),
    response: z.object({ logs: z.array(logEntrySchema) }),
  },

  'config:get': {
    request: empty,
    response: globalConfigSchema,
  },
  'config:set': {
    request: globalConfigPatchSchema,
    response: globalConfigSchema,
  },

  'storage:get': {
    request: z.strictObject({ appSlug: slugSchema, key: storageKeySchema }),
    response: z.union([
      z.object({ found: z.literal(true), value: z.unknown() }),
      z.object({ found: z.literal(false) }),
    ]),
  },
  'storage:set': {
    request: z.strictObject({ appSlug: slugSchema, key: storageKeySchema, value: z.unknown() }),
    response: ok,
  },
  'storage:remove': {
    request: z.strictObject({ appSlug: slugSchema, key: storageKeySchema }),
    response: z.object({ removed: z.boolean() }),
  },
  'storage:list': {
    request: z.strictObject({ appSlug: slugSchema }),
    response: z.object({ keys: z.array(z.string()) }),
  },

  /** The app's calibration profile, and whether it matches the manifest's `calibration`. */
  'calibration:get': {
    request: z.strictObject({ appSlug: slugSchema }),
    response: z.object({ profile: calibrationProfileSchema.nullable(), calibrated: z.boolean() }),
  },
  /** Replaces the app's calibration profile. The kind must be the manifest's. */
  'calibration:save': {
    request: z.strictObject({ appSlug: slugSchema, profile: calibrationProfileInputSchema }),
    response: z.object({ profile: calibrationProfileSchema }),
  },
} as const;

export const welcomePayloadSchema = z.object({
  protocolVersion: z.number().int(),
  serverVersion: z.string(),
  clientId: z.string(),
  /** What this connection's token may do. */
  capabilities: z.array(
    z
      .string()
      .refine(isCapability)
      .transform((value) => value as Capability),
  ),
});

/** Payloads of the events with a fixed name. */
export const eventSchemas = {
  'server:welcome': welcomePayloadSchema,
  'server:log': logEntrySchema,
  'server:performance': performanceSampleSchema,
  'server:config-changed': globalConfigSchema,
  'app:config-changed': z.object({ appSlug: z.string(), settings: appDeviceSettingsSchema }),
  'app:settings-changed': z.object({ appSlug: z.string(), values: settingsValues }),
  'driver:state-changed': driverInfoSchema,
  'drivers:list-changed': z.object({ drivers: z.array(driverInfoSchema) }),
  'app:installed': installedAppSchema,
  'app:uninstalled': z.object({ slug: z.string() }),
  'apps:list-changed': z.object({
    apps: z.array(installedAppSchema),
    invalid: z.array(invalidAppSchema),
  }),
  'experience:state-changed': runningExperienceSchema,
  'experiences:list-changed': z.object({ experiences: z.array(runningExperienceSchema) }),
  'calibration:changed': z.object({ appSlug: z.string(), calibrated: z.boolean() }),
  'system:stats': systemStatsSchema,
} as const;

export { driverEventPayloadSchema };

/** Every client message. The gateway checks `v` separately to report a version mismatch. */
export const clientEnvelopeSchema = z.object({
  v: z.number(),
  id: z.string().max(128).optional(),
  type: z.string().min(1).max(128),
  payload: z.unknown().optional(),
});
