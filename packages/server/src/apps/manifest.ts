/**
 * App manifest discovery and validation. Apps live in
 * `<paths.apps>/<slug>/` with a `gosai.app.json` at the root.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AppManifest, AppRequirements, ExperienceDescriptor } from '@gosai/shared';

export interface DiscoveredApp {
  readonly manifest: AppManifest;
  readonly installPath: string;
  readonly manifestPath: string;
}

export class ManifestError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = 'ManifestError';
  }
}

export function discoverApps(appsDir: string): DiscoveredApp[] {
  if (!existsSync(appsDir)) return [];
  const out: DiscoveredApp[] = [];
  for (const entry of readdirSync(appsDir)) {
    if (entry.startsWith('.')) continue;
    const dir = join(appsDir, entry);
    let stat;
    try {
      stat = statSync(dir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    const manifestPath = join(dir, 'gosai.app.json');
    if (!existsSync(manifestPath)) continue;
    try {
      const manifest = parseManifest(manifestPath);
      out.push({ manifest, installPath: dir, manifestPath });
    } catch {
      // Ignored: invalid manifest. Caller can re-discover after fix.
    }
  }
  return out;
}

export function parseManifest(path: string): AppManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new ManifestError(path, `invalid JSON: ${String(err)}`);
  }
  return validateManifest(path, raw);
}

export function validateManifest(path: string, value: unknown): AppManifest {
  if (typeof value !== 'object' || value === null) {
    throw new ManifestError(path, 'manifest must be an object');
  }
  const v = value as Record<string, unknown>;

  const slug = requireString(path, v, 'slug');
  if (!/^[a-z][a-z0-9-]*$/.test(slug)) {
    throw new ManifestError(path, `invalid slug "${slug}"`);
  }
  const name = requireString(path, v, 'name');
  const version = requireString(path, v, 'version');
  const description = optionalString(path, v, 'description');
  const author = optionalString(path, v, 'author');
  const icon = optionalString(path, v, 'icon');
  const builtin = optionalBool(path, v, 'builtin') ?? false;

  const experiencesRaw = v.experiences;
  if (!Array.isArray(experiencesRaw) || experiencesRaw.length === 0) {
    throw new ManifestError(path, '`experiences` must be a non-empty array');
  }
  const experiences = experiencesRaw.map((exp, idx) =>
    validateExperience(path, exp, `experiences[${idx}]`),
  );

  const defaultSlug = optionalString(path, v, 'default');
  if (defaultSlug !== undefined && !experiences.some((e) => e.slug === defaultSlug)) {
    throw new ManifestError(
      path,
      `\`default\` "${defaultSlug}" does not match any experience slug`,
    );
  }

  const startupRaw = v.startup;
  let startup: readonly string[] | undefined;
  if (startupRaw !== undefined) {
    if (!Array.isArray(startupRaw) || !startupRaw.every((s) => typeof s === 'string')) {
      throw new ManifestError(path, '`startup` must be an array of experience slugs');
    }
    startup = startupRaw as string[];
  }

  const requirements = parseRequirements(path, v.requirements);

  let python: AppManifest['python'];
  if (v.python !== undefined) {
    if (typeof v.python !== 'object' || v.python === null) {
      throw new ManifestError(path, '`python` must be an object');
    }
    const py = v.python as Record<string, unknown>;
    python = {
      requirements: typeof py.requirements === 'string' ? py.requirements : undefined,
      module: typeof py.module === 'string' ? py.module : undefined,
    };
  }

  const result: AppManifest = {
    slug,
    name,
    version,
    experiences,
    ...(description !== undefined ? { description } : {}),
    ...(author !== undefined ? { author } : {}),
    ...(icon !== undefined ? { icon } : {}),
    ...(defaultSlug !== undefined ? { default: defaultSlug } : {}),
    ...(python ? { python } : {}),
    ...(startup ? { startup } : {}),
    ...(requirements ? { requirements } : {}),
    builtin,
  };
  return result;
}

function parseRequirements(path: string, value: unknown): AppRequirements | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ManifestError(path, '`requirements` must be an object');
  }
  const r = value as Record<string, unknown>;
  const display = optionalBool(path, r, 'display');
  const camera = optionalBool(path, r, 'camera');
  const microphone = optionalBool(path, r, 'microphone');
  const speaker = optionalBool(path, r, 'speaker');
  return {
    ...(display !== undefined ? { display } : {}),
    ...(camera !== undefined ? { camera } : {}),
    ...(microphone !== undefined ? { microphone } : {}),
    ...(speaker !== undefined ? { speaker } : {}),
  };
}

function validateExperience(path: string, value: unknown, label: string): ExperienceDescriptor {
  if (typeof value !== 'object' || value === null) {
    throw new ManifestError(path, `${label} must be an object`);
  }
  const v = value as Record<string, unknown>;
  const slug = requireScopedString(path, v, label, 'slug');
  const name = requireScopedString(path, v, label, 'name');
  const entry = requireScopedString(path, v, label, 'entry');
  const exclusive = (v.exclusive as boolean | undefined) ?? false;
  const drivers = Array.isArray(v.drivers)
    ? (v.drivers as unknown[]).filter((d): d is string => typeof d === 'string')
    : [];
  const allowed = Array.isArray(v.allowed)
    ? (v.allowed as unknown[]).filter((d): d is string => typeof d === 'string')
    : undefined;
  const required = Array.isArray(v.required)
    ? (v.required as unknown[]).filter((d): d is string => typeof d === 'string')
    : undefined;
  return {
    slug,
    name,
    entry,
    description: typeof v.description === 'string' ? v.description : undefined,
    python: typeof v.python === 'string' ? v.python : undefined,
    drivers,
    exclusive,
    allowed,
    required,
  };
}

function requireField(
  path: string,
  obj: Record<string, unknown>,
  field: string,
  kind: 'string' | 'number' | 'boolean',
): unknown {
  const segments = field.split('.');
  let cur: unknown = obj;
  for (const seg of segments) {
    if (typeof cur !== 'object' || cur === null) {
      throw new ManifestError(path, `missing required field ${field}`);
    }
    cur = (cur as Record<string, unknown>)[seg];
  }
  if (typeof cur !== kind) {
    throw new ManifestError(path, `${field} must be a ${kind}`);
  }
  return cur;
}

function requireString(path: string, obj: Record<string, unknown>, key: string): string {
  return requireField(path, obj, key, 'string') as string;
}

function requireScopedString(
  path: string,
  obj: Record<string, unknown>,
  label: string,
  key: string,
): string {
  const v = obj[key];
  if (typeof v !== 'string') {
    throw new ManifestError(path, `${label}.${key} must be a string`);
  }
  return v;
}

function optionalString(
  path: string,
  obj: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = obj[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') {
    throw new ManifestError(path, `${key} must be a string when provided`);
  }
  return v;
}

function optionalBool(
  path: string,
  obj: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const v = obj[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') {
    throw new ManifestError(path, `${key} must be a boolean when provided`);
  }
  return v;
}
