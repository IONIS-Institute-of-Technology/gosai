import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { DASHBOARD_ORIGIN, dashboardFile } from '../src/main/dashboard-origin.js';

const RENDERER = '/app/out/renderer';

describe('dashboardFile', () => {
  test('maps dashboard URLs to the built renderer', () => {
    expect(dashboardFile(RENDERER, `${DASHBOARD_ORIGIN}/dashboard.html?token=t`)).toBe(
      join(RENDERER, 'dashboard.html'),
    );
    expect(dashboardFile(RENDERER, `${DASHBOARD_ORIGIN}/assets/main%20x.js`)).toBe(
      join(RENDERER, 'assets', 'main x.js'),
    );
  });

  test('stays inside the renderer directory', () => {
    // The URL parser stops dot segments at the root; encoded slashes are refused.
    expect(dashboardFile(RENDERER, `${DASHBOARD_ORIGIN}/%2e%2e/main/index.js`)).toBe(
      join(RENDERER, 'main', 'index.js'),
    );
    expect(dashboardFile(RENDERER, `${DASHBOARD_ORIGIN}/..%2F..%2Fetc/passwd`)).toBeNull();
    expect(dashboardFile(RENDERER, `${DASHBOARD_ORIGIN}/assets%2F..%2F..%2Fmain`)).toBeNull();
    expect(dashboardFile(RENDERER, `${DASHBOARD_ORIGIN}/`)).toBeNull();
    expect(dashboardFile(RENDERER, `${DASHBOARD_ORIGIN}/a%00b`)).toBeNull();
    expect(dashboardFile(RENDERER, `${DASHBOARD_ORIGIN}/%E0%A4%A`)).toBeNull();
  });

  test('serves only the dashboard host', () => {
    expect(dashboardFile(RENDERER, 'gosai://other/dashboard.html')).toBeNull();
    expect(dashboardFile(RENDERER, 'file:///app/out/renderer/dashboard.html')).toBeNull();
  });
});
