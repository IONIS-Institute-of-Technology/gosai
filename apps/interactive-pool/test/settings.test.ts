import { describe, expect, test } from 'bun:test';
import type { AppManifest, ExperienceRuntimeContext } from '@gosai/sdk';
import manifestJson from '../gosai.app.json';
import {
  DEFAULT_SETTINGS,
  migrateLegacyRelayUrl,
  readPoolSettings,
  relayUrlProblem,
} from '../src/settings.js';

const manifest = manifestJson as unknown as AppManifest;

/** The nested defaults object the server builds from the manifest schema. */
function manifestDefaults(): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const field of manifest.settings?.groups.flatMap((g) => g.fields) ?? []) {
    const parts = field.key.split('.');
    let node = values;
    for (const part of parts.slice(0, -1)) {
      node = (node[part] ??= {}) as Record<string, unknown>;
    }
    node[parts.at(-1) ?? ''] = field.default;
  }
  return values;
}

describe('readPoolSettings', () => {
  test('the manifest defaults match the built-in defaults', () => {
    expect(readPoolSettings(manifestDefaults())).toEqual(DEFAULT_SETTINGS);
  });

  test('maps the nested settings object', () => {
    expect(
      readPoolSettings({
        debug: { title: false, renderFps: true, ballFps: true },
        live: { url: '  wss://relay.example/ws ' },
      }),
    ).toEqual({
      debug: { title: false, renderFps: true, ballFps: true },
      live: { url: 'wss://relay.example/ws' },
    });
  });

  test('falls back to the defaults for missing or mistyped values', () => {
    expect(readPoolSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(readPoolSettings({ debug: { title: 'no', ballFps: 1 }, live: { url: 5 } })).toEqual(
      DEFAULT_SETTINGS,
    );
    expect(readPoolSettings({ debug: { renderFps: true } }).debug).toEqual({
      ...DEFAULT_SETTINGS.debug,
      renderFps: true,
    });
  });
});

describe('relayUrlProblem', () => {
  test('accepts wss anywhere', () => {
    expect(relayUrlProblem('wss://relay.example/pool/ws', [])).toBeNull();
  });

  test('accepts ws only for an origin listed in network.connect', () => {
    expect(relayUrlProblem('ws://192.168.1.50:8080/ws', ['ws://192.168.1.50:8080'])).toBeNull();
    const problem = relayUrlProblem('ws://192.168.1.50:8080/ws', ['ws://192.168.1.50:9000']);
    expect(problem).toContain('"ws://192.168.1.50:8080" under network.connect');
  });

  test('rejects other schemes and invalid URLs', () => {
    expect(relayUrlProblem('https://relay.example', [])).toContain('must start with wss://');
    expect(relayUrlProblem('relay.example', [])).toContain('not a valid URL');
  });
});

describe('migrateLegacyRelayUrl', () => {
  function runtime(stored: Record<string, unknown>, settings: Record<string, unknown>) {
    const sets: Array<Record<string, unknown>> = [];
    const rt = {
      storage: {
        get: async (key: string) => stored[key],
        remove: async (key: string) => {
          delete stored[key];
        },
      },
      settings: {
        get: async () => settings,
        set: async (values: Record<string, unknown>) => void sets.push(values),
      },
      log: { info: () => undefined },
    } as unknown as ExperienceRuntimeContext;
    return { rt, sets };
  }

  test('moves the stored URL into the live.url setting once', async () => {
    const stored: Record<string, unknown> = { live_server_url: 'wss://old.example/ws' };
    const { rt, sets } = runtime(stored, { live: { url: '' } });
    await migrateLegacyRelayUrl(rt);
    await migrateLegacyRelayUrl(rt);
    expect(sets).toEqual([{ 'live.url': 'wss://old.example/ws' }]);
    expect(stored).toEqual({});
  });

  test('keeps a URL already set in the settings', async () => {
    const stored: Record<string, unknown> = { live_server_url: 'wss://old.example/ws' };
    const { rt, sets } = runtime(stored, { live: { url: 'wss://new.example/ws' } });
    await migrateLegacyRelayUrl(rt);
    expect(sets).toEqual([]);
    expect(stored).toEqual({});
  });
});
