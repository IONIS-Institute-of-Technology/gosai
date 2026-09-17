import { describe, expect, test } from 'bun:test';
import { mintAppToken, verifyToken, type TokenScope } from '@gosai/shared/auth';
import { assertSlug, isValidSlug } from '@gosai/shared/slug';
import { canSubscribe, commandDenial } from '../src/access/policy.js';
import { readBearerToken, RequestGuard } from '../src/access/request-guard.js';

const SECRET = 'dashboard-secret';
const DASHBOARD: TokenScope = { kind: 'dashboard' };
const POOL: TokenScope = { kind: 'app', appSlug: 'pool', slugs: ['pool'] };

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

describe('command policy', () => {
  test('the dashboard may run everything', () => {
    expect(commandDenial(DASHBOARD, 'app:install', { source: 'x' })).toBeNull();
    expect(commandDenial(DASHBOARD, 'driver:execute', { driver: 'camera' })).toBeNull();
  });

  test('apps may not install, uninstall or change the global config', () => {
    expect(commandDenial(POOL, 'app:install', { source: 'x' })).not.toBeNull();
    expect(commandDenial(POOL, 'app:uninstall', { slug: 'pool' })).not.toBeNull();
    expect(commandDenial(POOL, 'config:set', {})).not.toBeNull();
    expect(commandDenial(POOL, 'config:get', {})).toBeNull();
    expect(commandDenial(POOL, 'apps:list', {})).toBeNull();
  });

  test('apps only touch their own settings, events and drivers', () => {
    expect(commandDenial(POOL, 'app:config:get', { appSlug: 'pool' })).toBeNull();
    expect(commandDenial(POOL, 'app:config:set', { appSlug: 'other' })).not.toBeNull();
    expect(commandDenial(POOL, 'app:broadcast', { appSlug: 'other', topic: 't' })).not.toBeNull();
    expect(commandDenial(POOL, 'driver:execute', { driver: 'd', binding: 'pool' })).toBeNull();
    expect(
      commandDenial(POOL, 'driver:subscribe', { driver: 'd', binding: 'other' }),
    ).not.toBeNull();
    // A missing binding means the dashboard's `system` binding.
    expect(commandDenial(POOL, 'driver:get-data', { driver: 'd', event: 'e' })).not.toBeNull();
    expect(commandDenial(POOL, 'driver:get-data', null)).not.toBeNull();
    expect(
      commandDenial(POOL, 'experience:start', { appSlug: 'pool', experienceSlug: 'x' }),
    ).toBeNull();
    expect(
      commandDenial(POOL, 'experience:start', {
        appSlug: 'pool',
        experienceSlug: 'x',
        driverBinding: 'other',
      }),
    ).not.toBeNull();
  });

  test("apps may not use wildcards or other apps' topics", () => {
    expect(canSubscribe(DASHBOARD, '*')).toBe(true);
    expect(canSubscribe(POOL, '*')).toBe(false);
    expect(canSubscribe(POOL, 'driver:*')).toBe(false);
    expect(canSubscribe(POOL, 'app:*')).toBe(false);
    expect(canSubscribe(POOL, 'driver:event:pool')).toBe(true);
    expect(canSubscribe(POOL, 'driver:event:other')).toBe(false);
    expect(canSubscribe(POOL, 'app:pool:wizard:step')).toBe(true);
    expect(canSubscribe(POOL, 'app:other:wizard:step')).toBe(false);
    expect(canSubscribe(POOL, 'app:config-changed')).toBe(true);
    expect(canSubscribe(POOL, 'server:log')).toBe(true);
  });
});

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
