import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import type { AppManifest } from '@gosai/shared';
import { CALIBRATION_PROFILE_KEY } from '@gosai/shared/calibration';
import {
  CalibrationStore,
  LEGACY_CALIBRATION_KEYS,
  readLegacyProfile,
} from '../src/apps/calibration.js';
import { AppStorage } from '../src/apps/storage.js';

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const QUAD = [
  { x: 0.1, y: 0.1 },
  { x: 0.9, y: 0.1 },
  { x: 0.9, y: 0.9 },
  { x: 0.1, y: 0.9 },
];
const DATA = {
  homography: IDENTITY,
  homographyInverse: IDENTITY,
  homographySurface: IDENTITY,
  homographySurfaceInverse: IDENTITY,
  focusQuad: QUAD,
  surfaceQuadDisplay: QUAD,
  surfaceSize: { width: 1920, height: 1080 },
  frameSize: { width: 1280, height: 720 },
};

function manifest(slug: string, calibration?: AppManifest['calibration']): AppManifest {
  return {
    slug,
    name: slug,
    version: '1.0.0',
    experiences: [
      { slug: 'main', name: 'Main', entry: 'dist/main.js', drivers: [], exclusive: false },
    ],
    ...(calibration ? { calibration } : {}),
  };
}

function setup(): {
  store: CalibrationStore;
  storage: AppStorage & { dataDir: string };
  logs: string[];
} {
  const dataDir = mkdtempSync(join(tmpdir(), 'gosai-calibration-'));
  const storage = Object.assign(new AppStorage({ data: dataDir }), { dataDir });
  const manifests: Record<string, AppManifest> = {
    pool: manifest('pool', { kind: 'camera-projector-surface', required: true }),
    depth: manifest('depth', { kind: 'acme-depth', required: false, experience: 'main' }),
    plain: manifest('plain'),
  };
  const logs: string[] = [];
  const store = new CalibrationStore({
    getManifest: (slug) => manifests[slug],
    storage,
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
    now: () => 1234,
  });
  return { store, storage, logs };
}

function writeLegacy(
  storage: AppStorage,
  slug: string,
  keys: Partial<Record<string, unknown>>,
): void {
  for (const [key, value] of Object.entries(keys)) storage.set(slug, key, value);
}

const LEGACY = {
  [LEGACY_CALIBRATION_KEYS.Status]: { ok: true, completedAt: 99, kind: 'x', version: 1 },
  [LEGACY_CALIBRATION_KEYS.Homography]: IDENTITY,
  [LEGACY_CALIBRATION_KEYS.HomographyInverse]: IDENTITY,
  [LEGACY_CALIBRATION_KEYS.HomographySurface]: IDENTITY,
  [LEGACY_CALIBRATION_KEYS.HomographySurfaceInverse]: IDENTITY,
  [LEGACY_CALIBRATION_KEYS.FocusQuad]: { points: QUAD },
  [LEGACY_CALIBRATION_KEYS.SurfaceQuadDisplay]: { points: QUAD },
  [LEGACY_CALIBRATION_KEYS.SurfaceSize]: { width: 1920, height: 1080 },
  [LEGACY_CALIBRATION_KEYS.FrameSize]: { width: 1280, height: 720 },
};

describe('CalibrationStore', () => {
  test('an app without a profile is not calibrated', () => {
    const { store } = setup();
    expect(store.get('pool')).toEqual({ profile: null, calibrated: false });
    expect(() => store.get('ghost')).toThrow('not installed');
  });

  test('saves one versioned profile and derives "calibrated" from it', () => {
    const { store, storage } = setup();
    const saved = store.save('pool', { kind: 'camera-projector-surface', data: DATA });
    expect(saved).toEqual({
      version: 1,
      kind: 'camera-projector-surface',
      savedAt: 1234,
      data: DATA,
    });
    expect(storage.get('pool', CALIBRATION_PROFILE_KEY)).toEqual({ found: true, value: saved });
    expect(storage.list('pool')).toEqual([CALIBRATION_PROFILE_KEY]);
    expect(store.get('pool')).toEqual({ profile: saved, calibrated: true });
  });

  test('refuses profiles the manifest does not declare, and invalid data', () => {
    const { store } = setup();
    expect(() => store.save('plain', { kind: 'camera-projector-surface', data: DATA })).toThrow(
      'does not declare calibration',
    );
    expect(() => store.save('pool', { kind: 'acme-depth', data: {} })).toThrow(
      'calibrates as camera-projector-surface',
    );
    expect(() =>
      store.save('pool', {
        kind: 'camera-projector-surface',
        data: { ...DATA, homography: [1, 2, 3] },
      }),
    ).toThrow('Invalid camera-projector-surface calibration: homography');
    expect(store.get('pool').profile).toBeNull();
  });

  test('custom kinds store any data', () => {
    const { store } = setup();
    store.save('depth', { kind: 'acme-depth', data: { grid: [[1, 2]] } });
    expect(store.get('depth')).toMatchObject({
      calibrated: true,
      profile: { kind: 'acme-depth', data: { grid: [[1, 2]] } },
    });
  });

  test('a profile of another kind or version does not count as calibrated', () => {
    const { store, storage, logs } = setup();
    storage.set('pool', CALIBRATION_PROFILE_KEY, {
      version: 1,
      kind: 'acme-depth',
      savedAt: 1,
      data: {},
    });
    expect(store.get('pool').calibrated).toBe(false);
    storage.set('pool', CALIBRATION_PROFILE_KEY, { version: 2, kind: 'x', savedAt: 1, data: {} });
    expect(store.get('pool')).toEqual({ profile: null, calibrated: false });
    expect(logs).toContain('ignoring an unreadable calibration profile');
  });

  test('a corrupt profile file counts as no profile, and saving replaces it', () => {
    const { store, storage, logs } = setup();
    writeLegacy(storage, 'pool', LEGACY);
    const dir = join(storage.dataDir, 'pool', 'storage');
    writeFileSync(join(dir, `${CALIBRATION_PROFILE_KEY}.json`), '{not json');
    expect(store.get('pool')).toEqual({ profile: null, calibrated: false });
    expect(logs).toContain('ignoring an unreadable calibration profile');
    // The legacy keys aren't converted over an existing, if unreadable, profile.
    expect(storage.list('pool')).toContain(LEGACY_CALIBRATION_KEYS.Homography);
    store.save('pool', { kind: 'camera-projector-surface', data: DATA });
    expect(store.get('pool').calibrated).toBe(true);
  });

  test('converts the nine legacy keys into a profile once', () => {
    const { store, storage } = setup();
    writeLegacy(storage, 'pool', {
      ...LEGACY,
      [LEGACY_CALIBRATION_KEYS.MarkersLayout]: [],
      unrelated: 1,
    });
    const { profile, calibrated } = store.get('pool');
    expect(calibrated).toBe(true);
    expect(profile).toEqual({
      version: 1,
      kind: 'camera-projector-surface',
      savedAt: 99,
      data: DATA,
    });
    // The legacy keys are gone and the profile is stored.
    expect(storage.list('pool')).toEqual([CALIBRATION_PROFILE_KEY, 'unrelated']);
    expect(store.get('pool').profile).toEqual(profile);
  });

  test('saving removes leftover legacy keys', () => {
    const { store, storage } = setup();
    writeLegacy(storage, 'pool', { [LEGACY_CALIBRATION_KEYS.FocusQuad]: { points: QUAD } });
    store.save('pool', { kind: 'camera-projector-surface', data: DATA });
    expect(storage.list('pool')).toEqual([CALIBRATION_PROFILE_KEY]);
  });
});

describe('readLegacyProfile', () => {
  const reader =
    (keys: Record<string, unknown>) =>
    (key: string): unknown =>
      keys[key];

  test('fills optional legacy keys the old flow skipped', () => {
    const profile = readLegacyProfile(
      reader({
        [LEGACY_CALIBRATION_KEYS.Status]: { ok: true },
        [LEGACY_CALIBRATION_KEYS.Homography]: IDENTITY,
        [LEGACY_CALIBRATION_KEYS.HomographyInverse]: IDENTITY,
      }),
    );
    expect(profile).toEqual({
      version: 1,
      kind: 'camera-projector-surface',
      savedAt: 0,
      data: {
        homography: IDENTITY,
        homographyInverse: IDENTITY,
        homographySurface: null,
        homographySurfaceInverse: null,
        focusQuad: null,
        surfaceQuadDisplay: null,
        surfaceSize: { width: 1920, height: 1080 },
        frameSize: null,
      },
    });
  });

  test('needs the status key and valid matrices, like the old "calibrated" check', () => {
    const { [LEGACY_CALIBRATION_KEYS.Status]: _status, ...withoutStatus } = LEGACY;
    expect(readLegacyProfile(reader(withoutStatus))).toBeNull();
    expect(
      readLegacyProfile(reader({ ...LEGACY, [LEGACY_CALIBRATION_KEYS.Homography]: [1, 2] })),
    ).toBeNull();
    expect(
      readLegacyProfile(reader({ [LEGACY_CALIBRATION_KEYS.Status]: { ok: true } })),
    ).toBeNull();
  });
});
