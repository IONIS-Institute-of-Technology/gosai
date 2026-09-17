import { describe, expect, test } from 'bun:test';
import { createSettingsClient, serverSettingsBackend } from '../src/settings.js';
import { FakeServer } from './fakes.js';

describe('settings', () => {
  test('get returns the settings app:settings:get merged with the defaults', async () => {
    const server = new FakeServer();
    server.reply = () => ({ display: { mode: 'cover', zoom: 1 }, debug: false });
    const settings = createSettingsClient(serverSettingsBackend('demo', server.connection));
    const first = await settings.get();
    expect(first).toEqual({ display: { mode: 'cover', zoom: 1 }, debug: false });
    expect(server.requestsOf('app:settings:get').map((r) => r.payload)).toEqual([
      { appSlug: 'demo' },
    ]);
  });

  test('set sends only the given dotted keys, with null restoring a default', async () => {
    const server = new FakeServer();
    const settings = createSettingsClient(serverSettingsBackend('demo', server.connection));
    await settings.set({ 'display.zoom': 1.5, debug: true, 'display.mode': null });
    expect(server.requestsOf('app:settings:set').map((r) => r.payload)).toEqual([
      { appSlug: 'demo', values: { 'display.zoom': 1.5, debug: true, 'display.mode': null } },
    ]);
  });

  test('rejects values a setting cannot hold before calling the server', async () => {
    const server = new FakeServer();
    const settings = createSettingsClient(serverSettingsBackend('demo', server.connection));
    await expect(settings.set({ display: { zoom: 2 } })).rejects.toThrow('display');
    expect(server.requests).toEqual([]);
  });
});
