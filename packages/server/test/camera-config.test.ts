import { describe, expect, test } from 'bun:test';
import type { AppDeviceSettings, CameraSettings, GlobalConfig } from '@gosai/shared';
import {
  applyAppDeviceSettings,
  applyGlobalCameraSettings,
  driverConfigFor,
  resolveCameraSettings,
  type DeviceSettingsSources,
} from '../src/drivers/camera-config.js';
import type { DriverManager } from '../src/drivers/manager.js';
import type { ChildLogger } from '../src/logger/logger.js';

const GLOBAL_CAMERA: CameraSettings = { device: 0, width: 1280, height: 720, fps: 30 };

interface Settings {
  camera: CameraSettings;
  apps: Record<string, AppDeviceSettings>;
}

function sourcesFor(state: Settings): DeviceSettingsSources {
  return {
    config: {
      get: (): GlobalConfig => ({
        displayId: null,
        serverPort: 7777,
        autoStartApps: [],
        camera: state.camera,
      }),
    },
    appSettings: { get: (slug: string) => state.apps[slug] ?? {} },
  };
}

class FakeDrivers {
  readonly calls: Array<{ binding: string; driver: string; action: string; data: unknown }> = [];
  constructor(private readonly running: readonly string[]) {}
  isInstanceRunning(binding: string): boolean {
    return this.running.includes(binding);
  }
  runningBindings(): string[] {
    return [...this.running];
  }
  async execute(binding: string, driver: string, action: string, data: unknown): Promise<unknown> {
    this.calls.push({ binding, driver, action, data });
    return {};
  }
}

const log = { warn: () => undefined } as unknown as ChildLogger;

describe('camera config', () => {
  test('per-app fields override the global camera one by one', () => {
    expect(resolveCameraSettings(GLOBAL_CAMERA, { device: 2 })).toEqual({
      device: 2,
      width: 1280,
      height: 720,
      fps: 30,
      rotation: 0,
      focus: null,
    });
    expect(resolveCameraSettings({ ...GLOBAL_CAMERA, rotation: 90 }, { fps: 60 }).rotation).toBe(
      90,
    );
  });

  test('an app follows the global focus unless it pins its own', () => {
    const manual = { ...GLOBAL_CAMERA, focus: 120 };
    expect(resolveCameraSettings(GLOBAL_CAMERA, undefined).focus).toBeNull();
    expect(resolveCameraSettings(manual, { device: 2 }).focus).toBe(120);
    expect(resolveCameraSettings(manual, { focus: 40 }).focus).toBe(40);
  });

  test('a global focus change reaches the running camera', async () => {
    const src = sourcesFor({ camera: { ...GLOBAL_CAMERA, focus: 120 }, apps: {} });
    const drivers = new FakeDrivers(['pool']);
    await applyGlobalCameraSettings(drivers as unknown as DriverManager, src, GLOBAL_CAMERA, log);
    expect(drivers.calls).toHaveLength(1);
    expect(drivers.calls[0]).toMatchObject({ action: 'set_mode', data: { focus: 120 } });
  });

  test('cold start uses the same resolution as hot apply', () => {
    const src = sourcesFor({
      camera: GLOBAL_CAMERA,
      apps: { pool: { camera: { device: 1 } as CameraSettings } },
    });
    expect(driverConfigFor(src, 'pool', 'camera')).toEqual({
      device: 1,
      width: 1280,
      height: 720,
      fps: 30,
      rotation: 0,
      focus: null,
    });
    // The system binding ignores per-app settings.
    expect(driverConfigFor(src, 'system', 'camera')).toEqual({
      ...GLOBAL_CAMERA,
      rotation: 0,
      focus: null,
    });
    expect(driverConfigFor(src, 'pool', 'microphone')).toBeUndefined();
  });

  test('a global change is applied to every running camera it affects', async () => {
    const state: Settings = {
      camera: GLOBAL_CAMERA,
      apps: {
        pool: { camera: { device: 1 } as CameraSettings },
        pinned: { camera: { device: 2, width: 640, height: 480, fps: 15, rotation: 0 } },
      },
    };
    const drivers = new FakeDrivers(['system', 'pool', 'pinned']);
    state.camera = { ...GLOBAL_CAMERA, width: 1920, height: 1080 };

    await applyGlobalCameraSettings(
      drivers as unknown as DriverManager,
      sourcesFor(state),
      GLOBAL_CAMERA,
      log,
    );

    expect(drivers.calls).toEqual([
      {
        binding: 'system',
        driver: 'camera',
        action: 'set_mode',
        data: { device: 0, width: 1920, height: 1080, fps: 30, rotation: 0, focus: null },
      },
      {
        binding: 'pool',
        driver: 'camera',
        action: 'set_mode',
        data: { device: 1, width: 1920, height: 1080, fps: 30, rotation: 0, focus: null },
      },
    ]);
  });

  test('an app change applies the resolved camera, and only when it changed', async () => {
    const state: Settings = { camera: GLOBAL_CAMERA, apps: {} };
    const src = sourcesFor(state);
    const drivers = new FakeDrivers(['pool']);

    state.apps.pool = { display: { id: null, mode: 'fullscreen' } };
    await applyAppDeviceSettings(drivers as unknown as DriverManager, src, 'pool', {}, log);
    expect(drivers.calls).toEqual([]);

    const previous = state.apps.pool;
    state.apps.pool = { ...previous, camera: { rotation: 180 } as CameraSettings };
    await applyAppDeviceSettings(drivers as unknown as DriverManager, src, 'pool', previous, log);
    expect(drivers.calls.map((c) => c.data)).toEqual([
      { device: 0, width: 1280, height: 720, fps: 30, rotation: 180, focus: null },
    ]);
  });
});
