import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import {
  deleteSettingValue,
  getSettingValue,
  isValidSettingKey,
  mergeSettings,
  setSettingValue,
  settingsDefaults,
} from '../src/app-settings.js';
import { COMMANDS } from '../src/commands.js';
import { EVENTS, eventMatches, parseEventName } from '../src/events.js';
import { formatLogEntry } from '../src/log-format.js';
import { manifestJsonSchema } from '../src/manifest-json-schema.js';
import { commandSchemas, eventSchemas } from '../src/protocol-schemas.js';
import {
  appDeviceSettingsPatchSchema,
  appManifestSchema,
  findRequiredCycle,
} from '../src/schemas.js';

describe('protocol maps', () => {
  test('every command has a schema and a spec, and every fixed event both', () => {
    expect(Object.keys(COMMANDS).sort()).toEqual(Object.keys(commandSchemas).sort());
    expect(Object.keys(EVENTS).sort()).toEqual(Object.keys(eventSchemas).sort());
  });

  test('device patches accept null to clear an override', () => {
    expect(
      appDeviceSettingsPatchSchema.safeParse({ camera: { device: null }, display: null }).success,
    ).toBe(true);
    expect(appDeviceSettingsPatchSchema.safeParse({ camera: { device: 'x' } }).success).toBe(false);
  });
});

describe('event names', () => {
  test('classifies fixed, driver and app events', () => {
    expect(parseEventName('app:config-changed')).toEqual({
      kind: 'fixed',
      name: 'app:config-changed',
    });
    expect(parseEventName('driver:event:pool')).toEqual({ kind: 'driver', binding: 'pool' });
    expect(parseEventName('app:pool:wizard:step')).toEqual({
      kind: 'app',
      appSlug: 'pool',
      topic: 'wizard:step',
    });
    expect(parseEventName('app:*')).toBeNull();
    expect(parseEventName('made:up')).toBeNull();
  });

  test('matches exact, namespace and catch-all patterns', () => {
    expect(eventMatches('*', 'server:log')).toBe(true);
    expect(eventMatches('server:*', 'server:log')).toBe(true);
    expect(eventMatches('server:*', 'serverx:log')).toBe(false);
    expect(eventMatches('server:log', 'server:log')).toBe(true);
  });
});

describe('manifest JSON Schema', () => {
  test('the committed schema matches the zod schema', () => {
    const committed = readFileSync(
      join(import.meta.dir, '..', 'schemas', 'gosai.app.schema.json'),
      'utf8',
    );
    // Run `bun run --filter @gosai/shared generate:schema` when this fails.
    expect(JSON.parse(committed)).toEqual(JSON.parse(manifestJsonSchema()));
  });

  test('every bundled manifest is valid', () => {
    const root = join(import.meta.dir, '..', '..', '..');
    for (const path of [
      'apps/calibration/gosai.app.json',
      'apps/interactive-pool/gosai.app.json',
      'apps/second-self/gosai.app.json',
      'templates/basic/gosai.app.json',
    ]) {
      const result = appManifestSchema.safeParse(
        JSON.parse(readFileSync(join(root, path), 'utf8')),
      );
      expect({ path, issues: result.error?.issues ?? [] }).toEqual({ path, issues: [] });
    }
  });

  test('finds required cycles', () => {
    expect(findRequiredCycle([{ slug: 'a', required: ['b'] }, { slug: 'b' }])).toBeNull();
    expect(
      findRequiredCycle([
        { slug: 'a', required: ['b'] },
        { slug: 'b', required: ['c'] },
        { slug: 'c', required: ['b'] },
      ]),
    ).toEqual(['b', 'c', 'b']);
  });
});

describe('app settings helpers', () => {
  const schema = {
    groups: [
      {
        label: 'G',
        fields: [
          { key: 'projection.mode', label: 'Mode', type: 'string' as const, default: 'direct' },
          { key: 'debug', label: 'Debug', type: 'boolean' as const, default: false },
          { key: 'zoom', label: 'Zoom', type: 'number' as const },
        ],
      },
    ],
  };

  test('builds nested defaults and merges stored values over them', () => {
    const defaults = settingsDefaults(schema);
    expect(defaults).toEqual({ projection: { mode: 'direct' }, debug: false });
    expect(mergeSettings(defaults, { projection: { mirror: true }, debug: true })).toEqual({
      projection: { mode: 'direct', mirror: true },
      debug: true,
    });
  });

  test('reads, writes and deletes dotted keys without touching the input', () => {
    const values = { projection: { mode: 'direct' } };
    const next = setSettingValue(values, 'projection.mirror', true);
    expect(values).toEqual({ projection: { mode: 'direct' } });
    expect(getSettingValue(next, 'projection.mirror')).toBe(true);
    expect(deleteSettingValue(next, 'projection.mode')).toEqual({ projection: { mirror: true } });
    expect(getSettingValue(next, 'constructor')).toBeUndefined();
  });

  test('rejects keys that would reach the object prototype', () => {
    expect(isValidSettingKey('projection.mode')).toBe(true);
    expect(isValidSettingKey('__proto__.polluted')).toBe(false);
    expect(isValidSettingKey('a..b')).toBe(false);
  });
});

describe('log formatting', () => {
  test('appends a lone detail and lists other data as key=value', () => {
    expect(formatLogEntry({ message: 'failed', data: { err: 'boom' } })).toEqual({
      message: 'failed: boom',
      details: null,
    });
    expect(formatLogEntry({ message: 'started', data: { driver: 'pose', fps: 30 } })).toEqual({
      message: 'started',
      details: 'driver=pose fps=30',
    });
    expect(formatLogEntry({ message: 'plain' })).toEqual({ message: 'plain', details: null });
  });
});

describe('manifest network origins', () => {
  const manifest = (connect: string[]): unknown => ({
    slug: 'app',
    name: 'App',
    version: '1.0.0',
    experiences: [{ slug: 'main', name: 'Main', entry: 'main.js' }],
    network: { connect },
  });

  test('accepts plain http, https, ws and wss origins', () => {
    const origins = [
      'ws://relay.local:8080',
      'wss://example.com',
      'http://192.168.1.10:3000',
      'https://[::1]:8443',
    ];
    expect(appManifestSchema.safeParse(manifest(origins)).success).toBe(true);
  });

  test('rejects paths, wildcards, other schemes and CSP-breaking characters', () => {
    for (const origin of [
      'wss://example.com/path',
      'wss://*.example.com',
      'ftp://example.com',
      "wss://example.com 'unsafe-inline'",
      'wss://example.com;script-src',
      'wss://"example.com"',
      'example.com',
    ]) {
      expect({ origin, ok: appManifestSchema.safeParse(manifest([origin])).success }).toEqual({
        origin,
        ok: false,
      });
    }
  });
});

describe('manifest sdk range', () => {
  const manifest = (sdk: string): unknown => ({
    slug: 'app',
    name: 'App',
    version: '1.0.0',
    sdk,
    experiences: [{ slug: 'main', name: 'Main', entry: 'main.js' }],
  });

  test('accepts npm-style semver ranges', () => {
    for (const sdk of ['^0.1.0', '~0.1', '0.1.x', '*', '>=0.1.0 <1', '^0.1.0 || ^0.2.0', '1.0.0']) {
      expect({ sdk, ok: appManifestSchema.safeParse(manifest(sdk)).success }).toEqual({
        sdk,
        ok: true,
      });
    }
  });

  test('rejects strings that are not ranges', () => {
    for (const sdk of ['', 'latest', 'workspace:*', 'file:../sdk', '^0.1.0 or later', '1.2.3.4']) {
      expect({ sdk, ok: appManifestSchema.safeParse(manifest(sdk)).success }).toEqual({
        sdk,
        ok: false,
      });
    }
  });
});
