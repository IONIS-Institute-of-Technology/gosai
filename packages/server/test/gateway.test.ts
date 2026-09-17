import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerWebSocket } from 'bun';
import { describe, expect, test } from 'bun:test';
import type { TokenScope } from '@gosai/shared/auth';
import { grantFor } from '../src/access/capabilities.js';
import { EventBus } from '../src/ipc/bus.js';
import { WebSocketGateway, type ClientData, type CommandHandlers } from '../src/ipc/gateway.js';
import { Logger } from '../src/logger/logger.js';

interface Sent {
  readonly type: string;
  readonly payload: {
    readonly requestId?: string;
    readonly ok?: boolean;
    readonly data?: unknown;
    readonly error?: { readonly code: string; readonly message: string };
  };
}

class FakeSocket {
  readonly sent: Sent[] = [];
  constructor(readonly data: ClientData) {}
  send(message: string): void {
    this.sent.push(JSON.parse(message) as Sent);
  }
  close(): void {}
  /** Messages other than the welcome. */
  get messages(): Sent[] {
    return this.sent.filter((m) => m.type !== 'server:welcome');
  }
}

const DASHBOARD: TokenScope = { kind: 'dashboard' };
const POOL: TokenScope = { kind: 'app', appSlug: 'pool', driverBinding: null, target: null };

function setup(handlers: Partial<CommandHandlers> = {}): {
  bus: EventBus;
  gateway: WebSocketGateway;
  open(scope: TokenScope, id?: string): FakeSocket;
  send(socket: FakeSocket, message: unknown): Promise<Sent>;
} {
  const bus = new EventBus();
  const logger = new Logger({ logsDir: mkdtempSync(join(tmpdir(), 'gosai-gateway-')) });
  const gateway = new WebSocketGateway(bus, logger.child('ipc'), {
    serverVersion: '9.9.9',
    handlers: {
      'system:ping': () => ({ ts: 1 }),
      ...handlers,
    } as CommandHandlers,
  });
  let next = 0;
  return {
    bus,
    gateway,
    open(scope, id = `client-${++next}`) {
      const socket = new FakeSocket({ clientId: id, grant: grantFor(scope, () => []) });
      gateway.onOpen(socket as unknown as ServerWebSocket<ClientData>);
      return socket;
    },
    async send(socket, message) {
      const raw = typeof message === 'string' ? message : JSON.stringify(message);
      await gateway.onMessage(socket as unknown as ServerWebSocket<ClientData>, raw);
      return socket.sent.at(-1)!;
    },
  };
}

const errorCode = (reply: Sent): string | undefined => reply.payload.error?.code;

describe('gateway validation', () => {
  test('welcomes clients with the protocol version and their capabilities', () => {
    const { open } = setup();
    const welcome = open(POOL).sent[0] as unknown as {
      type: string;
      payload: { protocolVersion: number; serverVersion: string; capabilities: string[] };
    };
    expect(welcome.type).toBe('server:welcome');
    expect(welcome.payload.serverVersion).toBe('9.9.9');
    expect(welcome.payload.capabilities).toContain('drivers:use');
    expect(welcome.payload.capabilities).not.toContain('apps:manage');
  });

  test('rejects malformed messages with a precise error code', async () => {
    const { open, send } = setup();
    const socket = open(DASHBOARD);
    expect(errorCode(await send(socket, '{nope'))).toBe('INVALID_JSON');
    expect(errorCode(await send(socket, { id: 'a', type: 'system:ping' }))).toBe('INVALID_MESSAGE');
    expect(errorCode(await send(socket, { v: 2, id: 'b', type: 'system:ping' }))).toBe(
      'UNSUPPORTED_VERSION',
    );
    expect(errorCode(await send(socket, { v: 1, id: 'c', type: 'nope:nope' }))).toBe(
      'UNKNOWN_COMMAND',
    );
    const invalid = await send(socket, {
      v: 1,
      id: 'd',
      type: 'experience:start',
      payload: { appSlug: 'Bad Slug', extra: true },
    });
    expect(errorCode(invalid)).toBe('INVALID_PAYLOAD');
    expect(invalid.payload.requestId).toBe('d');
    expect(invalid.payload.error?.message).toContain('appSlug');
    expect(invalid.payload.error?.message).toContain('experienceSlug');
    expect(invalid.payload.error?.message).toContain('extra');
  });

  test('checks the capability before the payload, and the apps after it', async () => {
    const { open, send } = setup();
    const socket = open(POOL);
    // No capability: denied whatever the payload says.
    expect(errorCode(await send(socket, { v: 1, id: '1', type: 'app:install', payload: 42 }))).toBe(
      'FORBIDDEN',
    );
    // Capability held: the payload is validated, then the apps it names.
    expect(
      errorCode(
        await send(socket, { v: 1, id: '2', type: 'storage:get', payload: { appSlug: 'other' } }),
      ),
    ).toBe('INVALID_PAYLOAD');
    expect(
      errorCode(
        await send(socket, {
          v: 1,
          id: '3',
          type: 'storage:get',
          payload: { appSlug: 'other', key: 'k' },
        }),
      ),
    ).toBe('FORBIDDEN');
  });

  test('runs typed handlers with the parsed payload and reports their errors', async () => {
    const seen: unknown[] = [];
    const { open, send } = setup({
      'logs:history': (payload) => {
        seen.push(payload);
        return { logs: [] };
      },
      'config:get': () => {
        throw new Error('disk on fire');
      },
    });
    const socket = open(DASHBOARD);
    const reply = await send(socket, {
      v: 1,
      id: 'h',
      type: 'logs:history',
      payload: { limit: 5 },
    });
    expect(reply.payload).toEqual({ requestId: 'h', ok: true, data: { logs: [] } });
    expect(seen).toEqual([{ limit: 5 }]);
    // A missing payload counts as an empty one.
    expect((await send(socket, { v: 1, id: 'p', type: 'system:ping' })).payload.ok).toBe(true);
    const failed = await send(socket, { v: 1, id: 'c', type: 'config:get' });
    expect(failed.payload.error).toEqual({ code: 'HANDLER_ERROR', message: 'disk on fire' });
  });
});

describe('gateway delivery', () => {
  test('delivers only to subscribers, never back to the sender of the event', async () => {
    const { bus, open, send } = setup();
    const sender = open(POOL, 'sender');
    const receiver = open(POOL, 'receiver');
    const bystander = open(POOL, 'bystander');
    for (const socket of [sender, receiver]) {
      await send(socket, { v: 1, id: 's', type: 'subscribe', payload: { events: ['app:pool:t'] } });
    }
    const before = [sender.messages.length, receiver.messages.length, bystander.messages.length];
    bus.emit('app:pool:t', { n: 1 }, 'app:pool', 'sender');
    expect(sender.messages.length).toBe(before[0]!);
    expect(bystander.messages.length).toBe(before[2]!);
    expect(receiver.messages.at(-1)).toMatchObject({ type: 'app:pool:t', payload: { n: 1 } });
  });

  test('serializes an event only when someone receives it', () => {
    const { bus, open } = setup();
    open(DASHBOARD);
    const payload = {
      toJSON(): never {
        throw new Error('serialized without a subscriber');
      },
    };
    expect(() => bus.emit('driver:event:pool', payload as never)).not.toThrow();
  });

  test('keeps allowed events of a partly denied batch and names the denied ones', async () => {
    const { bus, open, send } = setup();
    const socket = open(POOL);
    const reply = await send(socket, {
      v: 1,
      id: 'b',
      type: 'subscribe',
      payload: { events: ['app:pool:ok', 'server:log', 'app:other:no'] },
    });
    expect(errorCode(reply)).toBe('FORBIDDEN');
    expect(reply.payload.error?.message).toContain('server:log');
    expect(reply.payload.error?.message).toContain('app:other:no');
    expect(reply.payload.error?.message).not.toContain('app:pool:ok');
    bus.emit('app:pool:ok', 1);
    expect(socket.messages.at(-1)).toMatchObject({ type: 'app:pool:ok' });
  });

  test("filters events about other apps out of an app's stream", async () => {
    const { bus, open, send } = setup();
    const pool = open(POOL);
    const dashboard = open(DASHBOARD);
    await send(pool, {
      v: 1,
      id: 's',
      type: 'subscribe',
      payload: { events: ['app:config-changed'] },
    });
    await send(dashboard, { v: 1, id: 's', type: 'subscribe', payload: { events: ['*'] } });
    const poolBefore = pool.messages.length;
    bus.emit('app:config-changed', { appSlug: 'other', settings: {} });
    expect(pool.messages.length).toBe(poolBefore);
    expect(dashboard.messages.at(-1)).toMatchObject({ type: 'app:config-changed' });
    bus.emit('app:config-changed', { appSlug: 'pool', settings: {} });
    expect(pool.messages.at(-1)).toMatchObject({ payload: { appSlug: 'pool' } });
  });
});
