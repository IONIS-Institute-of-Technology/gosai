import { describe, expect, test } from 'bun:test';
import { mintAppToken, verifyToken, type TokenScope } from '@gosai/shared/auth';
import { assertSlug, isValidSlug } from '@gosai/shared/slug';
import {
  ALL_CAPABILITIES,
  CAPABILITY_INFO,
  DEFAULT_APP_CAPABILITIES,
  type Capability,
} from '@gosai/shared/capabilities';
import { COMMANDS } from '@gosai/shared/commands';
import type { CommandName } from '@gosai/shared/protocol';
import {
  canReceive,
  commandDenial,
  grantFor,
  subscriptionDenial,
  type Grant,
} from '../src/access/capabilities.js';
import { readBearerToken, RequestGuard } from '../src/access/request-guard.js';

const SECRET = 'dashboard-secret';
const DASHBOARD: TokenScope = { kind: 'dashboard' };

describe('tokens', () => {
  test('the dashboard token has the dashboard scope', () => {
    expect(verifyToken(SECRET, SECRET)).toEqual(DASHBOARD);
  });

  test('an app token carries its app and granted apps', () => {
    const token = mintAppToken(SECRET, 'calibration', ['pool', 'calibration']);
    expect(verifyToken(SECRET, token)).toEqual({
      kind: 'app',
      appSlug: 'calibration',
      slugs: ['calibration', 'pool'],
    });
  });

  test('rejects missing, forged and tampered tokens', () => {
    const token = mintAppToken(SECRET, 'pool');
    expect(verifyToken(SECRET, null)).toBeNull();
    expect(verifyToken(SECRET, '')).toBeNull();
    expect(verifyToken(SECRET, 'guess')).toBeNull();
    expect(verifyToken('other-secret', token)).toBeNull();
    expect(verifyToken(SECRET, token.replace('app.pool.', 'app.other.'))).toBeNull();
    expect(verifyToken(SECRET, `${token}x`)).toBeNull();
    expect(verifyToken('', '')).toBeNull();
  });

  test('refuses to mint tokens for invalid slugs', () => {
    expect(() => mintAppToken(SECRET, '../x')).toThrow();
    expect(() => mintAppToken(SECRET, 'pool', ['a+b'])).toThrow();
    // `system` is the dashboard's driver binding.
    expect(() => mintAppToken(SECRET, 'system')).toThrow('reserved');
    expect(() => mintAppToken(SECRET, 'pool', ['system'])).toThrow('reserved');
  });
});

describe('slug validation', () => {
  test('accepts manifest-style slugs', () => {
    for (const slug of ['pool', 'interactive-pool', 'a1', 'system']) {
      expect(isValidSlug(slug)).toBe(true);
    }
  });

  test('rejects traversal, separators and other junk', () => {
    for (const slug of ['', '../../x', 'a/b', 'a\\b', '.hidden', 'Pool', '1abc', 'a b', 'a:b']) {
      expect(isValidSlug(slug)).toBe(false);
    }
    expect(isValidSlug('a'.repeat(65))).toBe(false);
    expect(isValidSlug(42)).toBe(false);
    expect(() => assertSlug('../x', 'appSlug')).toThrow(/appSlug/);
  });
});

describe('capabilities', () => {
  const manifests: Record<string, readonly Capability[]> = {
    pool: [],
    logger: ['logs:read', 'app-config:write'],
    greedy: ['apps:manage', 'config:write', 'devices:read'],
  };
  const grant = (scope: TokenScope): Grant => grantFor(scope, (slug) => manifests[slug]);
  const app = (slug: string, extra: string[] = []): Grant =>
    grant({ kind: 'app', appSlug: slug, slugs: [slug, ...extra] });
  const DASH = grant(DASHBOARD);
  const POOL_GRANT = app('pool');

  test('the dashboard holds every capability', () => {
    expect([...DASH.capabilities].sort()).toEqual([...ALL_CAPABILITIES].sort());
  });

  test('apps get the defaults plus what their manifest requests, never dashboard-only ones', () => {
    expect([...POOL_GRANT.capabilities].sort()).toEqual([...DEFAULT_APP_CAPABILITIES].sort());
    expect(app('logger').capabilities.has('logs:read')).toBe(true);
    expect(app('logger').capabilities.has('app-config:write')).toBe(true);
    const greedy = app('greedy');
    expect(greedy.capabilities.has('devices:read')).toBe(true);
    expect(greedy.capabilities.has('apps:manage')).toBe(false);
    expect(greedy.capabilities.has('config:write')).toBe(false);
    // An app whose manifest can't be found still gets the defaults.
    expect(app('ghost').capabilities.size).toBe(DEFAULT_APP_CAPABILITIES.length);
  });

  test('every command declares a capability, and dashboard-only ones stay with the dashboard', () => {
    for (const [command, spec] of Object.entries(COMMANDS)) {
      if (spec.capability !== null) expect(CAPABILITY_INFO[spec.capability]).toBeDefined();
      expect(commandDenial(DASH, command as CommandName, payloadFor(command))).toBeNull();
    }
    expect(commandDenial(POOL_GRANT, 'app:install', { source: 'x' })).toContain('apps:manage');
    expect(commandDenial(POOL_GRANT, 'app:uninstall', { slug: 'pool' })).toContain('apps:manage');
    expect(commandDenial(POOL_GRANT, 'config:set', {})).toContain('config:write');
    expect(commandDenial(POOL_GRANT, 'config:get', {})).toBeNull();
    expect(commandDenial(POOL_GRANT, 'apps:list', {})).toBeNull();
    expect(commandDenial(POOL_GRANT, 'system:ping', {})).toBeNull();
  });

  test('requestable capabilities need the manifest to ask for them', () => {
    expect(commandDenial(POOL_GRANT, 'logs:history', {})).toContain('logs:read');
    expect(commandDenial(app('logger'), 'logs:history', {})).toBeNull();
    expect(commandDenial(POOL_GRANT, 'devices:list', {})).toContain('devices:read');
    expect(
      commandDenial(POOL_GRANT, 'app:config:set', { appSlug: 'pool', settings: {} }),
    ).toContain('app-config:write');
    expect(
      commandDenial(app('logger'), 'app:config:set', { appSlug: 'logger', settings: {} }),
    ).toBeNull();
  });

  test('apps only touch their own settings, storage, events and drivers', () => {
    expect(commandDenial(POOL_GRANT, 'app:config:get', { appSlug: 'pool' })).toBeNull();
    expect(commandDenial(POOL_GRANT, 'app:config:get', { appSlug: 'other' })).not.toBeNull();
    expect(commandDenial(POOL_GRANT, 'app:settings:get', { appSlug: 'other' })).not.toBeNull();
    expect(commandDenial(POOL_GRANT, 'storage:get', { appSlug: 'pool', key: 'k' })).toBeNull();
    expect(
      commandDenial(POOL_GRANT, 'storage:set', { appSlug: 'other', key: 'k', value: 1 }),
    ).not.toBeNull();
    expect(
      commandDenial(POOL_GRANT, 'app:broadcast', { appSlug: 'other', topic: 't' }),
    ).not.toBeNull();
    expect(
      commandDenial(POOL_GRANT, 'driver:execute', { driver: 'd', action: 'a', binding: 'pool' }),
    ).toBeNull();
    expect(
      commandDenial(POOL_GRANT, 'driver:subscribe', { driver: 'd', event: 'e', binding: 'other' }),
    ).not.toBeNull();
    // A missing binding means the dashboard's `system` binding.
    expect(
      commandDenial(POOL_GRANT, 'driver:get-data', { driver: 'd', event: 'e' }),
    ).not.toBeNull();
    expect(
      commandDenial(POOL_GRANT, 'experience:start', { appSlug: 'pool', experienceSlug: 'x' }),
    ).toBeNull();
    expect(
      commandDenial(POOL_GRANT, 'experience:start', {
        appSlug: 'pool',
        experienceSlug: 'x',
        driverBinding: 'other',
      }),
    ).not.toBeNull();
    expect(
      commandDenial(POOL_GRANT, 'experience:stop', { appSlug: 'other', experienceSlug: 'x' }),
    ).not.toBeNull();
  });

  test('a token that names extra apps reaches them', () => {
    const calibration = app('calibration', ['pool']);
    expect(
      commandDenial(calibration, 'storage:set', { appSlug: 'pool', key: 'k', value: 1 }),
    ).toBeNull();
    expect(
      commandDenial(calibration, 'experience:start', {
        appSlug: 'calibration',
        experienceSlug: 'calibrate',
        driverBinding: 'pool',
      }),
    ).toBeNull();
  });

  test("apps never reach the dashboard's system binding", () => {
    const forged = grant({ kind: 'app', appSlug: 'pool', slugs: ['pool', 'system'] });
    expect(
      commandDenial(forged, 'driver:execute', { driver: 'd', action: 'a', binding: 'system' }),
    ).not.toBeNull();
    expect(commandDenial(forged, 'driver:get-data', { driver: 'd', event: 'e' })).not.toBeNull();
    expect(subscriptionDenial(forged, 'driver:event:system')).not.toBeNull();
  });

  test('apps log only under their own source', () => {
    expect(
      commandDenial(POOL_GRANT, 'app:log', { source: 'app:pool:main', message: 'm' }),
    ).toBeNull();
    expect(commandDenial(POOL_GRANT, 'app:log', { source: 'app:pool', message: 'm' })).toBeNull();
    expect(
      commandDenial(POOL_GRANT, 'app:log', { source: 'app:other:main', message: 'm' }),
    ).not.toBeNull();
    expect(commandDenial(POOL_GRANT, 'app:log', { source: 'server', message: 'm' })).not.toBeNull();
    expect(commandDenial(DASH, 'app:log', { source: 'server', message: 'm' })).toBeNull();
  });

  test("apps may not use wildcards, other apps' topics or the server log", () => {
    expect(subscriptionDenial(DASH, '*')).toBeNull();
    expect(subscriptionDenial(POOL_GRANT, '*')).not.toBeNull();
    expect(subscriptionDenial(POOL_GRANT, 'driver:*')).not.toBeNull();
    expect(subscriptionDenial(POOL_GRANT, 'app:*')).not.toBeNull();
    expect(subscriptionDenial(POOL_GRANT, 'driver:event:pool')).toBeNull();
    expect(subscriptionDenial(POOL_GRANT, 'driver:event:other')).not.toBeNull();
    expect(subscriptionDenial(POOL_GRANT, 'app:pool:wizard:step')).toBeNull();
    expect(subscriptionDenial(POOL_GRANT, 'app:other:wizard:step')).not.toBeNull();
    expect(subscriptionDenial(POOL_GRANT, 'app:config-changed')).toBeNull();
    expect(subscriptionDenial(POOL_GRANT, 'experience:state-changed')).toBeNull();
    expect(subscriptionDenial(POOL_GRANT, 'server:log')).toContain('logs:read');
    expect(subscriptionDenial(app('logger'), 'server:log')).toBeNull();
    expect(subscriptionDenial(DASH, 'no-such-event')).toBe('unknown event');
  });

  test("events about one app only reach that app's tokens", () => {
    const changed = { appSlug: 'other', settings: {} };
    expect(canReceive(DASH, 'app:config-changed', changed)).toBe(true);
    expect(canReceive(POOL_GRANT, 'app:config-changed', changed)).toBe(false);
    expect(canReceive(POOL_GRANT, 'app:config-changed', { ...changed, appSlug: 'pool' })).toBe(
      true,
    );
    expect(canReceive(POOL_GRANT, 'server:log', {})).toBe(false);
    expect(canReceive(POOL_GRANT, 'system:stats', {})).toBe(true);
  });
});

function payloadFor(command: string): never {
  const payloads: Record<string, unknown> = {
    'app:log': { source: 'app:pool', message: 'm' },
    'experience:start': { appSlug: 'pool', experienceSlug: 'main' },
  };
  const payload = payloads[command] ?? {
    appSlug: 'pool',
    slug: 'pool',
    binding: 'pool',
    key: 'k',
  };
  return payload as never;
}

describe('request guard', () => {
  const guard = new RequestGuard({
    bindHost: '127.0.0.1',
    port: () => 7777,
    allowedOrigins: ['file://', 'null'],
  });
  const request = (headers: Record<string, string>): Request => {
    const req = new Request('http://127.0.0.1:7777/v1/info');
    // Request normally fills Host from the URL; tests need to control it.
    req.headers.delete('host');
    for (const [name, value] of Object.entries(headers)) req.headers.set(name, value);
    return req;
  };

  test('allows loopback hosts on the bound port', () => {
    expect(guard.hostAllowed('127.0.0.1:7777')).toBe(true);
    expect(guard.hostAllowed('localhost:7777')).toBe(true);
    expect(guard.hostAllowed('[::1]:7777')).toBe(true);
  });

  test('rejects rebinding hosts, other ports and a missing Host', () => {
    expect(guard.hostAllowed('evil.example:7777')).toBe(false);
    expect(guard.hostAllowed('127.0.0.1:8080')).toBe(false);
    expect(guard.hostAllowed('127.0.0.1')).toBe(false);
    expect(guard.hostAllowed('user@127.0.0.1:7777')).toBe(false);
    expect(guard.hostAllowed(null)).toBe(false);
  });

  test('allows configured extra hosts', () => {
    const lan = new RequestGuard({
      bindHost: '0.0.0.0',
      port: () => 80,
      allowedHosts: ['kiosk.local'],
    });
    expect(lan.hostAllowed('kiosk.local')).toBe(true);
    expect(lan.hostAllowed('0.0.0.0')).toBe(false);
  });

  test('allows loopback and configured origins only', () => {
    expect(guard.originAllowed('http://localhost:5173')).toBe(true);
    expect(guard.originAllowed('http://127.0.0.1:7777')).toBe(true);
    expect(guard.originAllowed('file://')).toBe(true);
    expect(guard.originAllowed('null')).toBe(true);
    expect(guard.originAllowed('https://evil.example')).toBe(false);
    expect(guard.originAllowed('http://127.0.0.1.evil.example')).toBe(false);
    const strict = new RequestGuard({ bindHost: '127.0.0.1', port: () => 7777 });
    expect(strict.originAllowed('null')).toBe(false);
  });

  test('rejects requests and reflects allowed origins without a wildcard', () => {
    expect(guard.reject(request({ host: '127.0.0.1:7777' }))).toBeNull();
    expect(guard.reject(request({ host: 'evil.example:7777' }))?.status).toBe(403);
    expect(
      guard.reject(request({ host: '127.0.0.1:7777', origin: 'https://evil.example' }))?.status,
    ).toBe(403);
    const cors = guard.corsHeaders(request({ host: '127.0.0.1:7777', origin: 'null' }));
    expect(cors['Access-Control-Allow-Origin']).toBe('null');
    expect(guard.corsHeaders(request({ origin: 'https://evil.example' }))).toEqual({});
  });

  test('reads bearer tokens', () => {
    expect(readBearerToken(request({ authorization: 'Bearer abc' }))).toBe('abc');
    expect(readBearerToken(request({ authorization: 'Basic abc' }))).toBeNull();
    expect(readBearerToken(request({}))).toBeNull();
  });
});
