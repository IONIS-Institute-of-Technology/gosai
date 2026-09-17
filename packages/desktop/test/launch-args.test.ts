import { describe, expect, test } from 'bun:test';
import { parseDisplayIndex, parseExtras, parseLaunchArgs } from '../src/main/launch-args.js';

describe('parseLaunchArgs', () => {
  test('reads kiosk flags and ignores Electron and Chromium switches', () => {
    const args = parseLaunchArgs([
      'packages/desktop',
      '--no-sandbox',
      '--enable-features=Foo',
      '--kiosk',
      'apps/pool',
      '--kiosk-display=1',
      '--kiosk-experience',
      'main',
      '--kiosk-python-extras',
      'speech, realsense',
      '--kiosk-home',
      '/tmp/pool',
      '--kiosk-windowed',
      '--kiosk-calibrate',
    ]);
    expect(args).toEqual({
      kiosk: 'apps/pool',
      kioskHome: '/tmp/pool',
      kioskDisplay: 1,
      kioskExperience: 'main',
      kioskPythonExtras: ['speech', 'realsense'],
      kioskWindowed: true,
      kioskCalibrate: true,
    });
  });

  test('is empty for a regular launch', () => {
    expect(parseLaunchArgs(['.', '--inspect'])).toEqual({
      kioskWindowed: false,
      kioskCalibrate: false,
    });
  });

  test('rejects missing values and bad display indexes', () => {
    expect(() => parseLaunchArgs(['--kiosk'])).toThrow('--kiosk needs a value');
    expect(() => parseLaunchArgs(['--kiosk', '--kiosk-windowed'])).toThrow('needs a value');
    expect(() => parseLaunchArgs(['--kiosk-display', 'left'])).toThrow('display index');
  });
});

describe('parseExtras', () => {
  test('splits, trims and drops empty entries', () => {
    expect(parseExtras(' speech,,realsense ,')).toEqual(['speech', 'realsense']);
    expect(parseExtras('')).toEqual([]);
  });
});

describe('parseDisplayIndex', () => {
  test('accepts non-negative integers only', () => {
    expect(parseDisplayIndex(' 2 ', 'X')).toBe(2);
    expect(() => parseDisplayIndex('-1', 'X')).toThrow('X must be a display index');
    expect(() => parseDisplayIndex('1.5', 'X')).toThrow();
  });
});
