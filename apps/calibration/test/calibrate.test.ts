import { describe, expect, test } from 'bun:test';
import type { AppManifest, ExperienceRuntimeContext } from '@gosai/sdk';
import runner, { loadTarget } from '../src/calibrate.js';

const RUNNER_MANIFEST: AppManifest = {
  slug: 'calibration',
  name: 'Calibration',
  version: '0.1.0',
  experiences: [
    {
      slug: 'calibrate',
      name: 'Calibrate',
      entry: 'dist/calibrate.js',
      drivers: [],
      exclusive: true,
    },
  ],
};

function manifest(slug: string, calibration?: AppManifest['calibration']): AppManifest {
  return { ...RUNNER_MANIFEST, slug, ...(calibration ? { calibration } : {}) };
}

function fakeRuntime(
  params: Record<string, string>,
  apps: AppManifest[],
): { rt: ExperienceRuntimeContext; emitted: Array<{ topic: string; data: unknown }> } {
  const emitted: Array<{ topic: string; data: unknown }> = [];
  const rt = {
    app: {
      appSlug: 'calibration',
      experienceSlug: 'calibrate',
      manifest: RUNNER_MANIFEST,
      experience: RUNNER_MANIFEST.experiences[0]!,
      params,
      serverBaseUrl: 'http://calibration.localhost:7777',
      server: {
        request: async (type: string) => {
          if (type !== 'apps:list') throw new Error(`unexpected ${type}`);
          return { apps: apps.map((m) => ({ manifest: m })), invalid: [] };
        },
      },
    },
    events: {
      emit: async (topic: string, data: unknown) => void emitted.push({ topic, data }),
      on: () => ({ unsubscribe: () => undefined }),
    },
  } as unknown as ExperienceRuntimeContext;
  return { rt, emitted };
}

describe('calibration runner start', () => {
  test('reports a target it cannot load as the result of the flow, then fails', async () => {
    for (const [params, apps, error] of [
      [{ role: 'control' }, [], 'without a target app'],
      [{ role: 'projector', target: 'pool' }, [], 'pool is not installed'],
      [{ role: 'control', target: 'plain' }, [manifest('plain')], 'declares no calibration'],
      [
        { role: 'control', target: 'depth' },
        [manifest('depth', { kind: 'acme-depth', required: false, experience: 'calibrate' })],
        "can't run the acme-depth kind",
      ],
    ] as const) {
      const { rt, emitted } = fakeRuntime(params, [...apps]);
      const state = { stop: null };
      await expect(runner.start!(rt, state)).rejects.toThrow(error);
      expect(emitted).toEqual([
        { topic: 'wizard:finished', data: { ok: false, error: expect.stringContaining(error) } },
      ]);
    }
  });

  test("loads the target's camera-projector-surface options", async () => {
    const options = { cornerLabels: ['A', 'B', 'C', 'D'] as const };
    const { rt } = fakeRuntime({ role: 'control', target: 'pool' }, [
      manifest('pool', { kind: 'camera-projector-surface', required: true, options }),
    ]);
    expect(await loadTarget(rt)).toEqual({ appSlug: 'pool', options });
  });
});
