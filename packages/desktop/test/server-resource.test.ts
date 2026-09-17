import { describe, expect, test } from 'bun:test';
import type { ConnectionStatus } from '@gosai/shared/client';
import { NotConnectedError } from '@gosai/shared/client';
import {
  EVENT_RENDER_DELAY_MS,
  RELOAD,
  ServerResource,
  type ResourceClient,
  type ResourceEvents,
  type ResourceRequest,
} from '../src/renderer/src/lib/server-resource.js';
import type { CommandName } from '@gosai/shared/protocol';

class FakeClient {
  readonly requests: Array<{ type: string; payload: unknown }> = [];
  readonly listeners = new Map<string, Set<(payload: unknown) => void>>();
  readonly statusListeners = new Set<(status: ConnectionStatus) => void>();
  status: ConnectionStatus = 'connected';
  responses: Array<() => Promise<unknown>> = [];

  request(type: string, payload?: unknown): Promise<unknown> {
    this.requests.push({ type, payload });
    const next = this.responses.shift();
    return next ? next() : Promise.resolve({ loaded: this.requests.length });
  }

  on(event: string, listener: (payload: unknown) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(listener);
    return () => set.delete(listener);
  }

  onStatus(listener: (status: ConnectionStatus) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => this.statusListeners.delete(listener);
  }

  emit(event: string, payload: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }

  setStatus(status: ConnectionStatus): void {
    this.status = status;
    for (const listener of this.statusListeners) listener(status);
  }
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function resource<C extends CommandName, T>(
  client: FakeClient,
  request: ResourceRequest<C, T>,
  events?: ResourceEvents<T>,
): ServerResource<C, T> {
  return new ServerResource(client as unknown as ResourceClient, request, events);
}

describe('ServerResource', () => {
  test('loads when subscribed while connected, and again on every reconnect', async () => {
    const client = new FakeClient();
    const apps = resource(client, { command: 'apps:list' });
    const renders: unknown[] = [];
    const off = apps.subscribe(() => renders.push(apps.getSnapshot()));
    await settle();
    expect(apps.getSnapshot()).toEqual({ data: { loaded: 1 }, error: null, loading: false });

    client.setStatus('disconnected');
    client.setStatus('connected');
    await settle();
    expect(apps.getSnapshot().data).toEqual({ loaded: 2 });
    expect(client.requests.map((r) => r.type)).toEqual(['apps:list', 'apps:list']);
    off();
    expect(client.statusListeners.size).toBe(0);
    expect(renders.length).toBeGreaterThan(0);
  });

  test('waits for the connection, and keeps data without an error when it is lost', async () => {
    const client = new FakeClient();
    client.status = 'connecting';
    const config = resource(client, { command: 'config:get' });
    config.subscribe(() => undefined);
    expect(client.requests).toEqual([]);

    client.setStatus('connected');
    await settle();
    expect(config.getSnapshot().data).toEqual({ loaded: 1 });

    client.responses.push(() => Promise.reject(new NotConnectedError()));
    await config.reload();
    expect(config.getSnapshot()).toEqual({ data: { loaded: 1 }, error: null, loading: false });

    client.responses.push(() => Promise.reject(new Error('boom')));
    await config.reload();
    expect(config.getSnapshot()).toMatchObject({ data: { loaded: 1 }, error: 'boom' });
  });

  test('applies events: a new value, a reload, or nothing', async () => {
    const client = new FakeClient();
    const calibration = resource(
      client,
      { command: 'calibration:get', payload: { appSlug: 'pool' } },
      {
        'calibration:changed': (p) => (p.appSlug === 'pool' ? RELOAD : undefined),
        'server:log': (entry) => ({ profile: null, calibrated: entry.message === 'yes' }),
      },
    );
    calibration.subscribe(() => undefined);
    await settle();
    expect(client.requests).toEqual([{ type: 'calibration:get', payload: { appSlug: 'pool' } }]);

    client.emit('calibration:changed', { appSlug: 'other', calibrated: true });
    client.emit('calibration:changed', { appSlug: 'pool', calibrated: true });
    await settle();
    expect(client.requests).toHaveLength(2);

    client.emit('server:log', { message: 'yes' });
    expect(calibration.getSnapshot().data).toMatchObject({ calibrated: true });
  });

  test('replays events that arrive during a load onto its result', async () => {
    const client = new FakeClient();
    const pending: Array<(value: unknown) => void> = [];
    const history = (): Promise<unknown> => new Promise((resolve) => pending.push(resolve));
    client.responses.push(history, history);
    const logs = resource(
      client,
      { command: 'logs:history', select: (r) => r.logs.map((entry) => entry.message) },
      { 'server:log': (entry, current) => [...(current ?? []), entry.message] },
    );
    logs.subscribe(() => undefined);
    client.emit('server:log', { message: 'c' });
    pending.shift()?.({ logs: [{ message: 'a' }, { message: 'b' }] });
    await settle();
    expect(logs.getSnapshot()).toEqual({ data: ['a', 'b', 'c'], error: null, loading: false });

    // The same on a reconnect, and a failed load keeps the event.
    client.setStatus('disconnected');
    client.setStatus('connected');
    client.emit('server:log', { message: 'd' });
    pending.shift()?.({ logs: [{ message: 'a' }, { message: 'b' }, { message: 'c' }] });
    await settle();
    expect(logs.getSnapshot().data).toEqual(['a', 'b', 'c', 'd']);

    client.responses.push(() => Promise.reject(new Error('boom')));
    const failed = logs.reload();
    client.emit('server:log', { message: 'e' });
    await failed;
    expect(logs.getSnapshot()).toMatchObject({ data: ['a', 'b', 'c', 'd', 'e'], error: 'boom' });
  });

  test('an event asking for a reload during a load loads again afterwards', async () => {
    const client = new FakeClient();
    let resolveFirst: (value: unknown) => void = () => undefined;
    client.responses.push(() => new Promise((resolve) => (resolveFirst = resolve)));
    const calibration = resource(
      client,
      { command: 'calibration:get', payload: { appSlug: 'pool' } },
      { 'calibration:changed': () => RELOAD },
    );
    calibration.subscribe(() => undefined);
    client.emit('calibration:changed', { appSlug: 'pool', calibrated: true });
    resolveFirst({ calibrated: false });
    await settle();
    await settle();
    expect(client.requests).toHaveLength(2);
    expect(calibration.getSnapshot().data as unknown).toEqual({ loaded: 2 });
  });

  test('drops a load that finishes after a newer value', async () => {
    const client = new FakeClient();
    let resolveSlow: (value: unknown) => void = () => undefined;
    client.responses.push(() => new Promise((resolve) => (resolveSlow = resolve)));
    const list = resource(
      client,
      { command: 'experiences:list', select: (r) => r.experiences },
      { 'experiences:list-changed': (p) => p.experiences },
    );
    list.subscribe(() => undefined);
    client.emit('experiences:list-changed', { experiences: ['fresh'] });
    resolveSlow({ experiences: ['stale'] });
    await settle();
    expect(list.getSnapshot().data as unknown).toEqual(['fresh']);
  });

  test('a burst of events notifies listeners once', async () => {
    const client = new FakeClient();
    const logs = resource(
      client,
      { command: 'logs:history', select: (r) => r.logs.map((entry) => entry.message) },
      { 'server:log': (entry, current) => [...(current ?? []), entry.message] },
    );
    let notified = 0;
    logs.subscribe(() => notified++);
    await settle();
    notified = 0;
    for (let i = 0; i < 100; i++) client.emit('server:log', { message: String(i) });
    // The snapshot is current at once; the render waits for the burst.
    expect(logs.getSnapshot().data).toHaveLength(100);
    expect(notified).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, EVENT_RENDER_DELAY_MS + 20));
    expect(notified).toBe(1);
  });

  test('a disabled resource neither loads nor listens', async () => {
    const client = new FakeClient();
    const devices = resource(
      client,
      { command: 'devices:list', enabled: false },
      {
        'apps:list-changed': () => ({ cameras: [], microphones: [], speakers: [] }),
      },
    );
    devices.subscribe(() => undefined);
    expect(await devices.reload()).toBeUndefined();
    await settle();
    expect(client.requests).toEqual([]);
    expect(client.listeners.size).toBe(0);
  });
});
