import { describe, expect, test } from 'bun:test';
import { createSettingsClient, serverSettingsBackend } from '../src/settings.js';
import { FakeServer } from './fakes.js';
import type { WelcomePayload } from '@gosai/shared/protocol';

const WELCOME = { protocolVersion: 1 } as WelcomePayload;

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

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

  test('onChange receives the settings changes of this app until removed', async () => {
    const server = new FakeServer();
    const settings = createSettingsClient(serverSettingsBackend('demo', server.connection));
    const seen: unknown[] = [];
    const off = settings.onChange((values) => seen.push(values));
    server.emit('app:settings-changed', { appSlug: 'other', values: { debug: true } });
    server.emit('app:settings-changed', { appSlug: 'demo', values: { debug: true } });
    off();
    server.emit('app:settings-changed', { appSlug: 'demo', values: { debug: false } });
    expect(seen).toEqual([{ debug: true }]);
    expect(server.listenerCount()).toBe(0);
  });

  test('onChange does nothing for a backend that cannot report changes', () => {
    const settings = createSettingsClient({
      load: async () => ({}),
      update: async () => undefined,
    });
    expect(() => settings.onChange(() => undefined)()).not.toThrow();
  });

  test('onChange reloads after a reconnect and reports settings changed meanwhile', async () => {
    const server = new FakeServer();
    let stored: Record<string, unknown> = { debug: false };
    server.reply = (type) => (type === 'app:settings:get' ? stored : { ok: true });
    const settings = createSettingsClient(serverSettingsBackend('demo', server.connection));
    const seen: unknown[] = [];
    const off = settings.onChange((values) => seen.push(values));
    await settle();

    // Reconnecting with nothing changed stays quiet.
    server.reconnect(WELCOME);
    await settle();
    expect(seen).toEqual([]);

    stored = { debug: true };
    server.reconnect(WELCOME);
    await settle();
    expect(seen).toEqual([{ debug: true }]);

    // The broadcast that follows the same change isn't reported twice.
    server.emit('app:settings-changed', { appSlug: 'demo', values: { debug: true } });
    expect(seen).toHaveLength(1);

    off();
    stored = { debug: false };
    server.reconnect(WELCOME);
    await settle();
    expect(seen).toHaveLength(1);
    expect(server.requestsOf('app:settings:get')).toHaveLength(3);
  });

  test('a reload that started before a broadcast does not undo it', async () => {
    const server = new FakeServer();
    let resolveLoad: (values: unknown) => void = () => undefined;
    server.reply = () => new Promise((resolve) => (resolveLoad = resolve));
    const settings = createSettingsClient(serverSettingsBackend('demo', server.connection));
    const seen: unknown[] = [];
    settings.onChange((values) => seen.push(values));

    server.reconnect(WELCOME);
    server.emit('app:settings-changed', { appSlug: 'demo', values: { debug: true } });
    resolveLoad({ debug: false });
    await settle();
    expect(seen).toEqual([{ debug: true }]);
  });
});
