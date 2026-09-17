import { describe, expect, test } from 'bun:test';
import {
  finishCalibration,
  loadCalibrationProfile,
  loadCameraProjectorSurfaceCalibration,
  readCalibrationLaunch,
  saveCameraProjectorSurfaceCalibration,
  type CalibrationRuntime,
  type CameraProjectorSurfaceCalibration,
} from '../src/calibration.js';
import type { AppContext, AppEventsClient } from '../src/types.js';
import { FakeServer, MANIFEST } from './fakes.js';

const DATA: CameraProjectorSurfaceCalibration = {
  homography: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  homographyInverse: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  homographySurface: null,
  homographySurfaceInverse: null,
  focusQuad: null,
  surfaceQuadDisplay: null,
  surfaceSize: { width: 1920, height: 1080 },
  frameSize: null,
};

function runtime(params: Record<string, string> = {}): {
  rt: CalibrationRuntime;
  server: FakeServer;
  emitted: Array<{ topic: string; data: unknown }>;
} {
  const server = new FakeServer();
  const emitted: Array<{ topic: string; data: unknown }> = [];
  const events: AppEventsClient = {
    emit: async (topic, data) => void emitted.push({ topic, data }),
    on: () => ({ unsubscribe: () => undefined }),
  };
  const app: AppContext = {
    appSlug: 'demo',
    experienceSlug: 'main',
    manifest: MANIFEST,
    experience: MANIFEST.experiences[0]!,
    params,
    server: server.connection,
    serverBaseUrl: 'http://demo.localhost:7777',
  };
  return { rt: { app, events }, server, emitted };
}

describe('calibration profiles', () => {
  test('loading returns null when nothing is saved', async () => {
    const { rt, server } = runtime();
    server.reply = () => ({ profile: null, calibrated: false });
    expect(await loadCalibrationProfile(rt)).toBeNull();
    expect(await loadCameraProjectorSurfaceCalibration(rt)).toBeNull();
    expect(server.requestsOf('calibration:get')[0]?.payload).toEqual({ appSlug: 'demo' });
  });

  test('loads the data of the requested kind only', async () => {
    const { rt, server } = runtime();
    const profile = {
      version: 1 as const,
      kind: 'camera-projector-surface',
      savedAt: 5,
      data: DATA,
    };
    server.reply = () => ({ profile, calibrated: true });
    expect(await loadCameraProjectorSurfaceCalibration(rt)).toEqual(DATA);
    expect(await loadCalibrationProfile(rt, { kind: 'acme-depth' })).toBeNull();
    expect(await loadCalibrationProfile(rt, { appSlug: 'pool' })).toEqual(profile);
    expect(server.requestsOf('calibration:get')[2]?.payload).toEqual({ appSlug: 'pool' });
  });

  test('saves for the running app or the app a flow runs for', async () => {
    const { rt, server } = runtime();
    server.reply = (_type, payload) => ({
      profile: { version: 1, savedAt: 1, ...(payload as { profile: object }).profile },
    });
    const saved = await saveCameraProjectorSurfaceCalibration(rt, DATA, { appSlug: 'pool' });
    expect(saved.data).toEqual(DATA);
    expect(server.requestsOf('calibration:save')[0]?.payload).toEqual({
      appSlug: 'pool',
      profile: { kind: 'camera-projector-surface', data: DATA },
    });
  });
});

describe('calibration flows', () => {
  test('reads the role and target of the window', () => {
    expect(readCalibrationLaunch(runtime({ role: 'control', target: 'pool' }).rt)).toEqual({
      role: 'control',
      target: 'pool',
    });
    // A custom flow opened without params calibrates its own app, as a projector.
    expect(readCalibrationLaunch(runtime().rt)).toEqual({ role: 'projector', target: 'demo' });
  });

  test('finishing broadcasts the result on the app events', async () => {
    const { rt, emitted } = runtime();
    await finishCalibration(rt, { ok: false, error: 'no camera' });
    expect(emitted).toEqual([
      { topic: 'wizard:finished', data: { ok: false, error: 'no camera' } },
    ]);
  });
});
