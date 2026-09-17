import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { appSlugFromHostname } from '@gosai/shared/app-origin';
import {
  appContentSecurityPolicy,
  appOriginDenial,
  isConnectSource,
  appSlugFromHost,
  appSlugFromOrigin,
  resolveSdkFile,
} from '../src/apps/app-host.js';

describe('app hostnames', () => {
  test('parses slugs from hostnames, Host headers and origins', () => {
    expect(appSlugFromHostname('my-app.localhost')).toBe('my-app');
    expect(appSlugFromHostname('My-App.LOCALHOST')).toBe('my-app');
    expect(appSlugFromHost('my-app.localhost:7777')).toBe('my-app');
    expect(appSlugFromOrigin('http://my-app.localhost:7777')).toBe('my-app');
  });

  test('rejects anything that is not a single valid slug label', () => {
    for (const hostname of [
      'localhost',
      '.localhost',
      'a.b.localhost',
      '9app.localhost',
      'x.com',
    ]) {
      expect(appSlugFromHostname(hostname)).toBeNull();
    }
    expect(appSlugFromHost(null)).toBeNull();
    expect(appSlugFromHost('127.0.0.1:7777')).toBeNull();
    expect(appSlugFromOrigin('null')).toBeNull();
    expect(appSlugFromOrigin('https://my-app.localhost')).toBeNull();
  });
});

describe('appOriginDenial', () => {
  const app = { kind: 'app', appSlug: 'pool', slugs: ['pool', 'other'] } as const;
  const request = (headers: Record<string, string>): Request => {
    const req = new Request('http://127.0.0.1:7777/v1/info');
    req.headers.delete('host');
    for (const [name, value] of Object.entries(headers)) req.headers.set(name, value);
    return req;
  };

  test('ignores requests that do not come from an app origin', () => {
    expect(appOriginDenial(request({ host: '127.0.0.1:7777' }), { kind: 'dashboard' })).toBeNull();
    expect(appOriginDenial(request({ host: '127.0.0.1:7777', origin: 'null' }), app)).toBeNull();
  });

  test("requires the origin's own app token", () => {
    expect(appOriginDenial(request({ host: 'pool.localhost:7777' }), app)).toBeNull();
    // Granted extra slugs don't make a token usable from those apps' origins.
    expect(appOriginDenial(request({ host: 'other.localhost:7777' }), app)).toContain('other');
    expect(
      appOriginDenial(request({ host: 'pool.localhost:7777' }), { kind: 'dashboard' }),
    ).toContain('dashboard');
  });

  test('the Origin header wins over Host', () => {
    const req = request({ host: '127.0.0.1:7777', origin: 'http://other.localhost:7777' });
    expect(appOriginDenial(req, app)).not.toBeNull();
  });
});

describe('resolveSdkFile', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gosai-sdk-'));
  writeFileSync(join(dir, 'index.js'), '');
  writeFileSync(join(dir, 'index-abc123.js'), '');
  mkdirSync(join(dir, 'nested.js'));

  test('resolves bundle files with or without .js', () => {
    expect(resolveSdkFile(dir, 'index.js')).toBe(join(dir, 'index.js'));
    expect(resolveSdkFile(dir, 'index')).toBe(join(dir, 'index.js'));
    expect(resolveSdkFile(dir, 'index-abc123.js')).toBe(join(dir, 'index-abc123.js'));
  });

  test('refuses traversal, directories and missing files', () => {
    for (const name of ['../index.js', '..', '.hidden.js', 'nested.js', 'missing', 'a/b.js']) {
      expect(resolveSdkFile(dir, name)).toBeNull();
    }
  });
});

describe('network.connect sources', () => {
  test('accepts plain scheme://host[:port] origins', () => {
    for (const source of [
      'ws://relay.local:8080',
      'wss://example.com',
      'http://192.168.1.20',
      'https://api.example.com:443',
      'ws://[fe80::1]:9000',
      'http://localhost:65535',
    ]) {
      expect(isConnectSource(source)).toBe(true);
    }
  });

  test('rejects anything that could change the policy or widen it', () => {
    for (const source of [
      'ftp://example.com',
      'ws://relay.local:8080/path',
      'ws://relay.local/',
      'ws://*.local',
      "ws://a.local 'unsafe-eval'",
      'ws://a.local;script-src *',
      'ws://a.local:70000',
      '"ws://a.local"',
      'ws://',
      'relay.local:8080',
      'ws://-bad.local',
      42,
    ]) {
      expect(isConnectSource(source)).toBe(false);
    }
  });

  test('the policy appends valid sources and drops invalid ones', () => {
    const csp = appContentSecurityPolicy({
      port: 7777,
      connect: ['ws://relay.local:8080', "ws://x; script-src 'unsafe-inline'"],
    });
    const connect = csp.split('; ').find((d) => d.startsWith('connect-src'));
    expect(connect).toBe("connect-src 'self' blob: data: https: wss: ws://relay.local:8080");
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).toContain("script-src 'self' http://*.localhost:7777 ");
  });
});
