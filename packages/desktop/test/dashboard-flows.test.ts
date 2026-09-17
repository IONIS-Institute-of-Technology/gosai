import { describe, expect, test } from 'bun:test';
import type { InstalledApp } from '@gosai/shared';
import { ServerRequestError } from '@gosai/shared/client';
import {
  cameraDevicePatch,
  choosePreferredFps,
  parseCameraFormats,
  resolutionPatch,
} from '../src/renderer/src/lib/camera.js';
import { deviceFromSelectValue, deviceToSelectValue } from '../src/renderer/src/lib/devices.js';
import {
  capabilityChoices,
  hasPermissionRequests,
  installApp,
  sdkRangeLabel,
  saveCapabilityGrants,
  type InstallClient,
} from '../src/renderer/src/lib/install.js';

function app(
  overrides: Partial<InstalledApp['manifest']> = {},
  granted: string[] = [],
): InstalledApp {
  return {
    manifest: {
      slug: 'relay',
      name: 'Relay',
      version: '1.0.0',
      experiences: [],
      capabilities: ['devices:read', 'logs:read'],
      ...overrides,
    },
    installedAt: 0,
    source: 'git',
    builtin: false,
    grantedCapabilities: granted,
    state: 'installed',
  } as InstalledApp;
}

class FakeClient {
  readonly requests: Array<{ type: string; payload: unknown }> = [];
  failures: unknown[] = [];

  request(type: string, payload: unknown): Promise<unknown> {
    this.requests.push({ type, payload });
    const failure = this.failures.shift();
    if (failure) return Promise.reject(failure);
    return Promise.resolve(app());
  }

  get api(): InstallClient {
    return this as unknown as InstallClient;
  }
}

describe('install and capability approval', () => {
  test('installs with nothing granted and does not approve anything by itself', async () => {
    const client = new FakeClient();
    const installed = await installApp(client.api, 'https://example.com/relay.git', async () => {
      throw new Error('not asked');
    });
    expect(installed?.manifest.slug).toBe('relay');
    expect(client.requests).toEqual([
      {
        type: 'app:install',
        payload: { source: 'https://example.com/relay.git', capabilities: [] },
      },
    ]);
  });

  test('asks before reusing data from another source, and stops when declined', async () => {
    const conflict = new ServerRequestError('app:install', {
      code: 'HANDLER_ERROR',
      message: 'relay left data from another source',
      details: { reason: 'app-data-conflict' },
    });
    const client = new FakeClient();
    client.failures = [conflict];
    const asked: string[] = [];
    expect(
      await installApp(client.api, 'src', async (message) => (asked.push(message), false)),
    ).toBeNull();
    expect(asked).toEqual(['relay left data from another source']);
    expect(client.requests).toHaveLength(1);

    client.failures = [conflict];
    await installApp(client.api, 'src', async () => true);
    expect(client.requests.at(-1)).toEqual({
      type: 'app:install',
      payload: { source: 'src', capabilities: [], reuseData: true },
    });
  });

  test('other install errors propagate without asking', async () => {
    const client = new FakeClient();
    client.failures = [new Error('clone failed')];
    expect(installApp(client.api, 'src', async () => true)).rejects.toThrow('clone failed');
  });

  test('lists requested capabilities with their description and grant', () => {
    expect(capabilityChoices(app({}, ['logs:read']))).toEqual([
      {
        capability: 'devices:read',
        description: 'Enumerate cameras, microphones and speakers',
        granted: false,
      },
      {
        capability: 'logs:read',
        description: 'Read the server log, including other apps',
        granted: true,
      },
    ]);
    expect(hasPermissionRequests(app({ capabilities: [] }))).toBe(false);
    expect(
      hasPermissionRequests(
        app({ capabilities: [], network: { connect: ['ws://relay.local:8080'] } }),
      ),
    ).toBe(true);
  });

  test("labels the app's SDK range", () => {
    expect(sdkRangeLabel({ sdk: '^0.2.0' })).toBe('SDK ^0.2.0');
    expect(sdkRangeLabel({})).toBe('no SDK range declared');
  });

  test('saves only the approved capabilities the app requests', async () => {
    const client = new FakeClient();
    await saveCapabilityGrants(client.api, app(), new Set(['logs:read', 'config:write'] as const));
    expect(client.requests).toEqual([
      { type: 'app:capabilities:set', payload: { appSlug: 'relay', capabilities: ['logs:read'] } },
    ]);
  });
});

describe('camera pickers', () => {
  test('the Default camera entry clears the app override with null', () => {
    expect(deviceFromSelectValue('')).toBeNull();
    expect(deviceFromSelectValue('2')).toBe(2);
    expect(deviceToSelectValue(null)).toBe('');
    expect(cameraDevicePatch(deviceFromSelectValue(''))).toEqual({ camera: { device: null } });
    expect(cameraDevicePatch(deviceFromSelectValue('1'))).toEqual({ camera: { device: 1 } });
  });

  test('a new resolution keeps the frame rate when it can, else prefers 30 fps', () => {
    const formats = [
      { width: 640, height: 480, fps: [15, 30, 60] },
      { width: 1920, height: 1080, fps: [5, 25] },
    ];
    expect(resolutionPatch(formats, '640x480', 60)).toEqual({ width: 640, height: 480, fps: 60 });
    expect(resolutionPatch(formats, '640x480', 24)).toEqual({ width: 640, height: 480, fps: 30 });
    expect(resolutionPatch(formats, '1920x1080', 60)).toEqual({
      width: 1920,
      height: 1080,
      fps: 25,
    });
    expect(resolutionPatch(formats, '1x1', 30)).toBeNull();
    expect(choosePreferredFps({ width: 1, height: 1, fps: [60, 120] })).toBe(120);
  });

  test("reads the camera driver's list_formats result", () => {
    const formats = [{ width: 640, height: 480, fps: [30] }];
    expect(parseCameraFormats({ ok: true, device: 0, formats })).toEqual(formats);
    expect(() => parseCameraFormats({ ok: true, device: 0, formats: [] })).toThrow(
      'No supported camera modes detected',
    );
  });
});
