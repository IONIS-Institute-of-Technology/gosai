import { describe, expect, test } from 'bun:test';
import { dashboardContentSecurityPolicy } from '../src/main/dashboard-csp.js';

function directives(policy: string): Record<string, string[]> {
  return Object.fromEntries(
    policy.split(';').map((part) => {
      const [name = '', ...sources] = part.trim().split(/\s+/);
      return [name, sources];
    }),
  );
}

describe('dashboardContentSecurityPolicy', () => {
  test('allows only its own files and the server it connects to', () => {
    const policy = directives(
      dashboardContentSecurityPolicy({ server: { host: '127.0.0.1', port: 41234 } }),
    );
    expect(policy['default-src']).toEqual(["'none'"]);
    expect(policy['script-src']).toEqual(["'self'"]);
    expect(policy['style-src']).toEqual(["'self'"]);
    expect(policy['connect-src']).toEqual(['ws://127.0.0.1:41234']);
    expect(policy['img-src']).toEqual(["'self'", 'data:', 'http://127.0.0.1:41234']);
    expect(Object.values(policy).flat()).not.toContain('ws:');
    expect(Object.values(policy).flat()).not.toContain('http:');
  });

  test('brackets IPv6 hosts', () => {
    const policy = directives(
      dashboardContentSecurityPolicy({ server: { host: '::1', port: 7777 } }),
    );
    expect(policy['connect-src']).toEqual(['ws://[::1]:7777']);
  });

  test('lets the Vite dev server inject its client', () => {
    const policy = directives(
      dashboardContentSecurityPolicy({
        server: { host: '127.0.0.1', port: 7777 },
        devServerUrl: 'http://localhost:5173',
      }),
    );
    expect(policy['script-src']).toEqual(["'self'", "'unsafe-inline'"]);
    expect(policy['connect-src']).toEqual([
      'ws://127.0.0.1:7777',
      'http://localhost:5173',
      'ws://localhost:5173',
    ]);
  });
});
