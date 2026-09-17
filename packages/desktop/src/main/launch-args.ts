/**
 * Command-line flags of the GOSAI executable. Electron and Chromium add their
 * own switches (`--no-sandbox`, `--enable-logging`, ...), so unknown options
 * and positionals are ignored. Kiosk flags carry a `kiosk-` prefix to stay
 * clear of Chromium switches such as `--display`, which picks an X server.
 *
 * This module has no Electron import so scripts and tests can use it.
 */

import { parseArgs } from 'node:util';

export interface LaunchArgs {
  /** `--kiosk <app-dir>`: boot straight into this built app. */
  readonly kiosk?: string;
  /** `--kiosk-home <dir>`: data directory for this kiosk. */
  readonly kioskHome?: string;
  /** `--kiosk-display <index>`: 0-based display index. */
  readonly kioskDisplay?: number;
  /** `--kiosk-experience <slug>`: experience to boot. */
  readonly kioskExperience?: string;
  /** `--kiosk-python-extras <a,b>`: Python extras to install. */
  readonly kioskPythonExtras?: string[];
  /** `--kiosk-windowed`: open in a window instead of fullscreen. */
  readonly kioskWindowed: boolean;
  /** `--kiosk-calibrate`: run the calibration wizard before the app. */
  readonly kioskCalibrate: boolean;
}

export function parseLaunchArgs(argv: readonly string[]): LaunchArgs {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      kiosk: { type: 'string' },
      'kiosk-home': { type: 'string' },
      'kiosk-display': { type: 'string' },
      'kiosk-experience': { type: 'string' },
      'kiosk-python-extras': { type: 'string' },
      'kiosk-windowed': { type: 'boolean' },
      'kiosk-calibrate': { type: 'boolean' },
    },
    strict: false,
    allowPositionals: true,
  });

  const kiosk = stringValue(values, 'kiosk');
  const kioskHome = stringValue(values, 'kiosk-home');
  const display = stringValue(values, 'kiosk-display');
  const kioskExperience = stringValue(values, 'kiosk-experience');
  const extras = stringValue(values, 'kiosk-python-extras');
  return {
    ...(kiosk !== undefined ? { kiosk } : {}),
    ...(kioskHome !== undefined ? { kioskHome } : {}),
    ...(display !== undefined
      ? { kioskDisplay: parseDisplayIndex(display, '--kiosk-display') }
      : {}),
    ...(kioskExperience !== undefined ? { kioskExperience } : {}),
    ...(extras !== undefined ? { kioskPythonExtras: parseExtras(extras) } : {}),
    kioskWindowed: values['kiosk-windowed'] === true,
    kioskCalibrate: values['kiosk-calibrate'] === true,
  };
}

/** `"speech, realsense,"` -> `["speech", "realsense"]`. */
export function parseExtras(value: string): string[] {
  return value
    .split(',')
    .map((extra) => extra.trim())
    .filter(Boolean);
}

/** A 0-based display index. `source` names the flag or variable in the error. */
export function parseDisplayIndex(value: string, source: string): number {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`${source} must be a display index (0, 1, ...), got ${JSON.stringify(value)}`);
  }
  return Number(trimmed);
}

function stringValue(
  values: Record<string, string | boolean | (string | boolean)[] | undefined>,
  name: string,
): string | undefined {
  const value = values[name];
  if (value === undefined) return undefined;
  // Non-strict parsing hands `--kiosk --kiosk-windowed` the next flag as value.
  if (typeof value !== 'string' || value === '' || value.startsWith('--')) {
    throw new Error(`--${name} needs a value`);
  }
  return value;
}
