import { describe, expect, test } from 'bun:test';
import { appSlugFromHostname } from '@gosai/shared/app-origin';
import { readLaunchParams } from '../src/app-host-page.js';

describe('app host page', () => {
  test('reads the app slug from the hostname', () => {
    expect(appSlugFromHostname('second-self.localhost')).toBe('second-self');
    expect(appSlugFromHostname('localhost')).toBeNull();
    expect(appSlugFromHostname('127.0.0.1')).toBeNull();
    expect(appSlugFromHostname('a.b.localhost')).toBeNull();
  });

  test('keeps the token out of the params and the cleaned URL', () => {
    const launch = readLaunchParams(
      'http://calibration.localhost:7777/?experience=calibrate&token=app.x.y&role=control&target=pool',
    );
    expect(launch.token).toBe('app.x.y');
    expect(launch.params).toEqual({ experience: 'calibrate', role: 'control', target: 'pool' });
    expect(launch.cleanUrl).toBe(
      'http://calibration.localhost:7777/?experience=calibrate&role=control&target=pool',
    );
  });

  test('works without a token', () => {
    const launch = readLaunchParams('http://demo.localhost:7777/');
    expect(launch.token).toBeNull();
    expect(launch.params).toEqual({});
  });
});
