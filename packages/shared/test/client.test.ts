import { describe, expect, test } from 'bun:test';
import {
  ConnectionClosedError,
  NotConnectedError,
  RequestTimeoutError,
  ServerClient,
  ServerRequestError,
  type WebSocketLike,
} from '../src/client.js';

interface Outgoing {
  readonly v: number;
  readonly id: string;
  readonly type: string;
  readonly payload: Record<string, unknown>;
}

type Listener = (event: { readonly data?: unknown }) => void;

class FakeSocket implements WebSocketLike {
  readyState = 0;
  readonly sent: Outgoing[] = [];
  private readonly listeners = new Map<string, Listener[]>();

  constructor(readonly url: string) {}

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Outgoing);
  }

  close(): void {
    this.readyState = 3;
  }

  /** Opens the socket and sends the welcome, as the server does. */
  accept(clientId = 'c1'): void {
    this.readyState = 1;
    this.fire('open');
    this.receive({
      type: 'server:welcome',
      payload: { protocolVersion: 1, serverVersion: 't', clientId, capabilities: [] },
    });
  }

  receive(message: unknown): void {
    this.fire('message', { data: JSON.stringify(message) });
  }

  reply(request: Outgoing, data: unknown = { ok: true }): void {
    this.receive({ type: 'response', payload: { requestId: request.id, ok: true, data } });
  }

  fail(request: Outgoing, code: string, message: string): void {
    this.receive({
      type: 'response',
      payload: { requestId: request.id, ok: false, error: { code, message } },
    });
  }

  drop(): void {
    this.readyState = 3;
    this.fire('close');
  }

  ofType(type: string): Outgoing[] {
    return this.sent.filter((m) => m.type === type);
  }

  private fire(type: string, event: { data?: unknown } = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function setup(): {
  client: ServerClient;
  sockets: FakeSocket[];
  errors: Array<{ error: unknown; context: string }>;
  latest(): FakeSocket;
} {
  const sockets: FakeSocket[] = [];
  const client = new ServerClient({
    url: 'ws://127.0.0.1:7777/ws',
    token: 'secret',
    reconnectDelayMs: 0,
    createSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
  });
  const errors: Array<{ error: unknown; context: string }> = [];
  client.onError((error, context) => errors.push({ error, context }));
  return { client, sockets, errors, latest: () => sockets.at(-1)! };
}

/** Lets zero-delay reconnect timers and promise callbacks run. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('ServerClient requests', () => {
  test('sends the token and resolves typed replies', async () => {
    const { client, latest } = setup();
    client.connect();
    expect(latest().url).toContain('token=secret');
    latest().accept();
    expect(client.connected()).toBe(true);
    expect(client.serverInfo?.clientId).toBe('c1');

    const pending = client.request('apps:list');
    const sent = latest().ofType('apps:list')[0]!;
    expect(sent).toMatchObject({ v: 1, payload: {} });
    latest().reply(sent, { apps: [] });
    expect(await pending).toEqual({ apps: [] });
  });

  test('rejects with the server error code', async () => {
    const { client, latest } = setup();
    client.connect();
    latest().accept();
    const pending = client.request('config:set', { displayId: 1 });
    latest().fail(latest().ofType('config:set')[0]!, 'FORBIDDEN', 'nope');
    const error = await pending.catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ServerRequestError);
    expect((error as ServerRequestError).code).toBe('FORBIDDEN');
  });

  test('rejects at once while disconnected, and on timeout', async () => {
    const { client, latest } = setup();
    await expect(client.request('apps:list')).rejects.toBeInstanceOf(NotConnectedError);
    client.connect();
    await expect(client.request('apps:list')).rejects.toBeInstanceOf(NotConnectedError);
    latest().accept();
    await expect(client.request('apps:list', {}, { timeoutMs: 1 })).rejects.toBeInstanceOf(
      RequestTimeoutError,
    );
  });

  test('rejects pending requests when the socket closes instead of waiting for the timeout', async () => {
    const { client, latest } = setup();
    client.connect();
    latest().accept();
    const pending = client.request('driver:execute', { driver: 'camera', action: 'x' });
    latest().drop();
    await expect(pending).rejects.toBeInstanceOf(ConnectionClosedError);
    client.close();
  });
});

describe('ServerClient reconnects', () => {
  test("a late close from an old socket doesn't tear down its replacement", async () => {
    const { client, sockets, latest } = setup();
    // React StrictMode: mount, unmount, mount again.
    client.connect();
    const first = latest();
    client.close();
    client.connect();
    const second = latest();
    expect(sockets).toHaveLength(2);
    second.accept();

    const received: unknown[] = [];
    client.on('system:stats', (stats) => received.push(stats));
    first.drop();
    await settle();
    expect(client.connected()).toBe(true);
    expect(sockets).toHaveLength(2);

    first.receive({ type: 'system:stats', payload: 'stale' });
    second.receive({ type: 'system:stats', payload: 'fresh' });
    expect(received).toEqual(['fresh']);
    client.close();
  });

  test('re-sends every subscription in one batch after reconnecting', async () => {
    const { client, sockets, latest } = setup();
    client.on('apps:list-changed', () => undefined);
    client.connect();
    latest().accept();
    client.on('server:log', () => undefined);
    expect(
      latest()
        .ofType('subscribe')
        .map((m) => m.payload.events),
    ).toEqual([['apps:list-changed'], ['server:log']]);

    latest().drop();
    await settle();
    expect(sockets).toHaveLength(2);
    latest().accept('c2');
    expect(
      latest()
        .ofType('subscribe')
        .map((m) => m.payload.events),
    ).toEqual([['apps:list-changed', 'server:log']]);
    client.close();
  });

  test('keeps reconnecting until closed', async () => {
    const { client, sockets, latest } = setup();
    client.connect();
    latest().drop();
    await settle();
    latest().drop();
    await settle();
    expect(sockets.length).toBeGreaterThanOrEqual(3);
    client.close();
    const count = sockets.length;
    latest().drop();
    await settle();
    expect(sockets).toHaveLength(count);
  });
});

describe('ServerClient subscriptions and listeners', () => {
  test('listeners of the same event share one server subscription', () => {
    const { client, latest } = setup();
    client.connect();
    latest().accept();
    const offA = client.on('experience:state-changed', () => undefined);
    const offB = client.on('experience:state-changed', () => undefined);
    expect(latest().ofType('subscribe')).toHaveLength(1);
    offA();
    offA();
    expect(latest().ofType('unsubscribe')).toHaveLength(0);
    offB();
    expect(
      latest()
        .ofType('unsubscribe')
        .map((m) => m.payload.events),
    ).toEqual([['experience:state-changed']]);
    client.close();
  });

  test('dispatches to exact, namespace and catch-all listeners', () => {
    const { client, latest } = setup();
    client.connect();
    latest().accept();
    const seen: string[] = [];
    client.on('app:pool:step', () => seen.push('exact'));
    client.on('app:*', () => seen.push('namespace'));
    client.on('*', () => seen.push('all'));
    latest().receive({ type: 'app:pool:step', payload: null });
    expect(seen).toEqual(['exact', 'namespace', 'all']);
    client.close();
  });

  test('reports listener errors and keeps calling the other listeners', () => {
    const { client, latest, errors } = setup();
    client.connect();
    latest().accept();
    let called = false;
    client.on('system:stats', () => {
      throw new Error('listener broke');
    });
    client.on('system:stats', () => {
      called = true;
    });
    latest().receive({ type: 'system:stats', payload: {} });
    expect(called).toBe(true);
    expect(errors.map((e) => e.context)).toEqual(['listener for system:stats']);
    expect(String(errors[0]?.error)).toContain('listener broke');
    client.close();
  });

  test('reports a denied subscription', async () => {
    const { client, latest, errors } = setup();
    client.connect();
    latest().accept();
    client.on('server:log', () => undefined);
    latest().fail(latest().ofType('subscribe')[0]!, 'FORBIDDEN', 'requires logs:read');
    await settle();
    expect(errors[0]?.context).toBe('subscribe server:log');
    client.close();
  });
});

describe('ServerClient retained resources', () => {
  function driverLease(client: ServerClient, log: string[]) {
    return {
      acquire: async () => {
        log.push('acquire');
        await client.request('driver:subscribe', { driver: 'pose', event: 'raw', binding: 'pool' });
      },
      release: async () => {
        log.push('release');
        await client.request('driver:unsubscribe', {
          driver: 'pose',
          event: 'raw',
          binding: 'pool',
        });
      },
    };
  }

  test('holders of a key share one acquisition and the last release frees it', async () => {
    const { client, latest } = setup();
    client.connect();
    latest().accept();
    const log: string[] = [];
    const first = client.retain('pose', driverLease(client, log));
    const second = client.retain('pose', driverLease(client, log));
    await settle();
    latest().reply(latest().ofType('driver:subscribe')[0]!);
    await first.ready;
    expect(second.ready).toBe(first.ready);
    first.release();
    first.release();
    await settle();
    expect(log).toEqual(['acquire']);
    second.release();
    await settle();
    expect(log).toEqual(['acquire', 'release']);
    expect(latest().ofType('driver:unsubscribe')).toHaveLength(1);
    client.close();
  });

  test('acquires again after a reconnect, and reports a failure without giving up', async () => {
    const { client, latest, errors } = setup();
    const log: string[] = [];
    const held = client.retain('pose', driverLease(client, log));
    client.connect();
    latest().accept();
    await settle();
    latest().fail(latest().ofType('driver:subscribe')[0]!, 'HANDLER_ERROR', 'model missing');
    await expect(held.ready).rejects.toThrow('model missing');
    expect(errors[0]?.context).toBe('acquiring pose');

    latest().drop();
    await settle();
    latest().accept('c2');
    await settle();
    expect(latest().ofType('driver:subscribe')).toHaveLength(1);
    expect(log).toEqual(['acquire', 'acquire']);

    held.release();
    await settle();
    client.close();
  });

  test("a release while disconnected doesn't reach the server, which already forgot the lease", async () => {
    const { client, latest } = setup();
    client.connect();
    latest().accept();
    const log: string[] = [];
    const held = client.retain('pose', driverLease(client, log));
    await settle();
    latest().drop();
    held.release();
    await settle();
    latest().accept('c2');
    await settle();
    expect(log).toEqual(['acquire']);
    client.close();
  });
});

describe('ServerClient retained resources across reconnects', () => {
  test('an acquire queued for a replaced connection runs once, on the new one', async () => {
    const { client, sockets, latest } = setup();
    client.connect();
    latest().accept();
    const log: string[] = [];
    let slowRelease: () => void = () => undefined;
    // A slow release of an earlier holder keeps the queue for this key busy.
    const earlier = client.retain('pose', {
      acquire: async () => {
        log.push('acquire-1');
      },
      release: () =>
        new Promise<void>((resolve) => {
          log.push('release-1');
          slowRelease = resolve;
        }),
    });
    await settle();
    earlier.release();
    const held = client.retain('pose', {
      acquire: async () => {
        log.push(`acquire-2@${sockets.length}`);
      },
      release: async () => {
        log.push('release-2');
      },
    });
    await settle();
    // The connection drops and comes back while the queue is still blocked.
    latest().drop();
    await settle();
    latest().accept('c2');
    slowRelease();
    await settle();
    await held.ready;
    expect(log).toEqual(['acquire-1', 'release-1', 'acquire-2@2']);
    held.release();
    await settle();
    expect(log.at(-1)).toBe('release-2');
    client.close();
  });
});
