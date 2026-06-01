/**
 * WebSocket gateway. Bridges the in-process EventBus to connected clients
 * (Electron renderers, embedded app windows). Clients send typed `subscribe`
 * messages to enable forwarding for specific event names or patterns.
 */

import type { ServerWebSocket } from 'bun';
import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type ErrorPayload,
  type MessageEnvelope,
} from '@gosai/shared/protocol';
import type { EventBus } from './bus.js';
import type { ChildLogger } from '../logger/index.js';

export interface CommandContext {
  readonly clientId: string;
  readonly bus: EventBus;
}

export type CommandHandler = (
  msg: ClientMessage,
  ctx: CommandContext,
) => Promise<unknown> | unknown;

interface ClientState {
  readonly id: string;
  readonly socket: ServerWebSocket<ClientData>;
  readonly subscriptions: Set<string>;
}

export interface ClientData {
  readonly clientId: string;
}

export interface WebSocketGatewayOptions {
  /** Called when a client disconnects so callers can release any per-client
   * state (driver subscriptions, etc.). Thrown / rejected errors are logged
   * and swallowed. */
  readonly onClientDisconnect?: (clientId: string) => void | Promise<void>;
}

export class WebSocketGateway {
  private readonly clients = new Map<string, ClientState>();
  private readonly handlers = new Map<string, CommandHandler>();
  private readonly unsubscribeBus: () => void;
  private readonly log: ChildLogger;
  private readonly onClientDisconnect: ((clientId: string) => void | Promise<void>) | undefined;

  constructor(
    private readonly bus: EventBus,
    log: ChildLogger,
    options: WebSocketGatewayOptions = {},
  ) {
    this.log = log;
    this.onClientDisconnect = options.onClientDisconnect;
    this.unsubscribeBus = this.bus.on('*', (event, payload, meta) => {
      this.broadcast(event, payload, meta.timestamp);
    });
  }

  registerHandler(commandType: string, handler: CommandHandler): void {
    this.handlers.set(commandType, handler);
  }

  onOpen(socket: ServerWebSocket<ClientData>): void {
    const id = socket.data.clientId;
    this.clients.set(id, { id, socket, subscriptions: new Set() });
    this.send(socket, {
      v: PROTOCOL_VERSION,
      type: 'server:welcome',
      payload: {
        protocolVersion: PROTOCOL_VERSION,
        serverVersion: '0.1.0',
        clientId: id,
      },
      ts: Date.now(),
    });
    this.log.info(`client connected: ${id}`);
  }

  onClose(socket: ServerWebSocket<ClientData>): void {
    const id = socket.data.clientId;
    this.clients.delete(id);
    this.log.info(`client disconnected: ${id}`);
    if (this.onClientDisconnect) {
      try {
        const result = this.onClientDisconnect(id);
        if (result && typeof (result as Promise<void>).catch === 'function') {
          (result as Promise<void>).catch((err) =>
            this.log.warn('client disconnect hook rejected', { id, err: String(err) }),
          );
        }
      } catch (err) {
        this.log.warn('client disconnect hook threw', { id, err: String(err) });
      }
    }
  }

  async onMessage(socket: ServerWebSocket<ClientData>, raw: string | Buffer): Promise<void> {
    const text = typeof raw === 'string' ? raw : raw.toString('utf8');
    let parsed: ClientMessage;
    try {
      parsed = JSON.parse(text) as ClientMessage;
    } catch {
      this.sendError(socket, '', {
        code: 'INVALID_JSON',
        message: 'Failed to parse message as JSON',
      });
      return;
    }

    if (!parsed || typeof parsed !== 'object' || !parsed.type) {
      this.sendError(socket, '', {
        code: 'INVALID_MESSAGE',
        message: 'Missing required fields',
      });
      return;
    }

    if (parsed.type === 'subscribe' || parsed.type === 'unsubscribe') {
      this.handleSubscription(socket, parsed);
      this.respondOk(socket, parsed.id ?? '', { ok: true });
      return;
    }

    const handler = this.handlers.get(parsed.type);
    if (!handler) {
      this.sendError(socket, parsed.id ?? '', {
        code: 'UNKNOWN_COMMAND',
        message: `No handler registered for ${parsed.type}`,
      });
      return;
    }

    try {
      const data = await handler(parsed, {
        clientId: socket.data.clientId,
        bus: this.bus,
      });
      this.respondOk(socket, parsed.id ?? '', data);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.sendError(socket, parsed.id ?? '', { code: 'HANDLER_ERROR', message });
    }
  }

  close(): void {
    this.unsubscribeBus();
    for (const client of this.clients.values()) {
      try {
        client.socket.close();
      } catch {
        // ignore
      }
    }
    this.clients.clear();
  }

  private handleSubscription(
    socket: ServerWebSocket<ClientData>,
    msg: MessageEnvelope<'subscribe' | 'unsubscribe', { events: string[] }>,
  ): void {
    const client = this.clients.get(socket.data.clientId);
    if (!client) return;
    const events = Array.isArray(msg.payload?.events) ? msg.payload.events : [];
    if (msg.type === 'subscribe') {
      for (const e of events) client.subscriptions.add(e);
    } else {
      for (const e of events) client.subscriptions.delete(e);
    }
  }

  private broadcast(event: string, payload: unknown, timestamp: number): void {
    const envelope = {
      v: PROTOCOL_VERSION,
      type: event,
      payload,
      ts: timestamp,
    };
    const json = JSON.stringify(envelope);
    for (const client of this.clients.values()) {
      if (matchesSubscription(event, client.subscriptions)) {
        try {
          client.socket.send(json);
        } catch {
          // Socket may have died between iterations.
        }
      }
    }
  }

  private respondOk(socket: ServerWebSocket<ClientData>, requestId: string, data: unknown): void {
    this.send(socket, {
      v: PROTOCOL_VERSION,
      type: 'response',
      payload: { requestId, ok: true, data },
      ts: Date.now(),
    });
  }

  private sendError(
    socket: ServerWebSocket<ClientData>,
    requestId: string,
    error: ErrorPayload,
  ): void {
    this.send(socket, {
      v: PROTOCOL_VERSION,
      type: 'response',
      payload: { requestId, ok: false, error },
      ts: Date.now(),
    });
  }

  private send(socket: ServerWebSocket<ClientData>, msg: unknown): void {
    try {
      socket.send(JSON.stringify(msg));
    } catch {
      // Socket may have died.
    }
  }
}

function matchesSubscription(event: string, subscriptions: Set<string>): boolean {
  if (subscriptions.has('*')) return true;
  if (subscriptions.has(event)) return true;
  const colon = event.indexOf(':');
  if (colon !== -1) {
    if (subscriptions.has(`${event.slice(0, colon)}:*`)) return true;
  }
  return false;
}
