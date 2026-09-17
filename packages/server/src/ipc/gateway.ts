/**
 * WebSocket gateway. Validates every client message against the protocol
 * schemas, checks the token's capabilities, runs the command handler, and
 * forwards bus events to the clients subscribed to them.
 */

import type { ServerWebSocket } from 'bun';
import type { TokenScope } from '@gosai/shared/auth';
import { isCommandName } from '@gosai/shared/commands';
import {
  ErrorCodes,
  PROTOCOL_VERSION,
  type CommandName,
  type CommandResponse,
  type ErrorPayload,
  type ParsedCommandRequest,
  type WelcomePayload,
} from '@gosai/shared/protocol';
import { clientEnvelopeSchema, commandSchemas } from '@gosai/shared/protocol-schemas';
import { formatZodError } from '@gosai/shared/schemas';
import {
  canReceive,
  commandCapabilityDenial,
  commandDenial,
  subscriptionDenial,
  type Grant,
} from '../access/capabilities.js';
import type { ChildLogger } from '../logger/logger.js';
import type { EventBus, EventMeta } from './bus.js';

export interface CommandContext {
  readonly clientId: string;
  readonly grant: Grant;
}

type SubscriptionCommand = 'subscribe' | 'unsubscribe';

export type HandledCommand = Exclude<CommandName, SubscriptionCommand>;

export type CommandHandler<C extends HandledCommand> = (
  payload: ParsedCommandRequest<C>,
  ctx: CommandContext,
) => CommandResponse<C> | Promise<CommandResponse<C>>;

/** One handler per command; the gateway handles `subscribe` and `unsubscribe`. */
export type CommandHandlers = { readonly [C in HandledCommand]: CommandHandler<C> };

export interface ClientData {
  readonly clientId: string;
  /** Resolved from the token checked at the `/ws` upgrade. */
  readonly grant: Grant;
}

interface ClientState {
  readonly id: string;
  readonly socket: ServerWebSocket<ClientData>;
  readonly grant: Grant;
  readonly subscriptions: Set<string>;
}

export interface WebSocketGatewayOptions {
  readonly handlers: CommandHandlers;
  readonly serverVersion: string;
  /**
   * Called when a client disconnects so callers can release per-client state
   * such as driver subscriptions. Rejections are logged.
   */
  readonly onClientDisconnect?: (clientId: string) => Promise<void>;
}

export class WebSocketGateway {
  private readonly clients = new Map<string, ClientState>();
  private readonly unsubscribeBus: () => void;

  constructor(
    bus: EventBus,
    private readonly log: ChildLogger,
    private readonly options: WebSocketGatewayOptions,
  ) {
    this.unsubscribeBus = bus.on('*', (event, payload, meta) => this.deliver(event, payload, meta));
  }

  onOpen(socket: ServerWebSocket<ClientData>): void {
    const { clientId: id, grant } = socket.data;
    this.clients.set(id, { id, socket, grant, subscriptions: new Set() });
    const welcome: WelcomePayload = {
      protocolVersion: PROTOCOL_VERSION,
      serverVersion: this.options.serverVersion,
      clientId: id,
      capabilities: Array.from(grant.capabilities),
    };
    this.send(socket, {
      v: PROTOCOL_VERSION,
      type: 'server:welcome',
      payload: welcome,
      ts: Date.now(),
    });
    this.log.info(`client connected: ${id}`, { scope: describeScope(grant.scope) });
  }

  onClose(socket: ServerWebSocket<ClientData>): void {
    const id = socket.data.clientId;
    this.clients.delete(id);
    this.log.info(`client disconnected: ${id}`);
    this.options
      .onClientDisconnect?.(id)
      .catch((err: unknown) =>
        this.log.warn('client disconnect cleanup failed', { id, err: String(err) }),
      );
  }

  async onMessage(socket: ServerWebSocket<ClientData>, raw: string | Buffer): Promise<void> {
    const client = this.clients.get(socket.data.clientId);
    if (!client) return;

    let json: unknown;
    try {
      json = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
    } catch {
      this.sendError(socket, '', {
        code: ErrorCodes.InvalidJson,
        message: 'Failed to parse message as JSON',
      });
      return;
    }

    const envelope = clientEnvelopeSchema.safeParse(json);
    if (!envelope.success) {
      this.sendError(socket, requestIdOf(json), {
        code: ErrorCodes.InvalidMessage,
        message: formatZodError(envelope.error),
      });
      return;
    }
    const { v, type, payload } = envelope.data;
    const id = envelope.data.id ?? '';

    if (v !== PROTOCOL_VERSION) {
      this.sendError(socket, id, {
        code: ErrorCodes.UnsupportedVersion,
        message: `Protocol version ${v} is not supported; this server speaks ${PROTOCOL_VERSION}`,
        details: { supported: PROTOCOL_VERSION },
      });
      return;
    }
    if (!isCommandName(type)) {
      this.sendError(socket, id, {
        code: ErrorCodes.UnknownCommand,
        message: `Unknown command ${type}`,
      });
      return;
    }

    const capabilityDenial = commandCapabilityDenial(client.grant, type);
    if (capabilityDenial) {
      this.deny(client, id, capabilityDenial);
      return;
    }

    const parsed = commandSchemas[type].request.safeParse(payload ?? {});
    if (!parsed.success) {
      this.sendError(socket, id, {
        code: ErrorCodes.InvalidPayload,
        message: formatZodError(parsed.error),
      });
      return;
    }

    if (type === 'subscribe' || type === 'unsubscribe') {
      this.handleSubscription(client, id, type, parsed.data as ParsedCommandRequest<typeof type>);
      return;
    }

    await this.runCommand(client, id, type, parsed.data as ParsedCommandRequest<typeof type>);
  }

  close(): void {
    this.unsubscribeBus();
    for (const client of this.clients.values()) {
      try {
        client.socket.close();
      } catch {
        // Already closed.
      }
    }
    this.clients.clear();
  }

  private async runCommand<C extends HandledCommand>(
    client: ClientState,
    id: string,
    type: C,
    payload: ParsedCommandRequest<C>,
  ): Promise<void> {
    const denial = commandDenial(client.grant, type, payload);
    if (denial) {
      this.deny(client, id, denial);
      return;
    }
    const handler = this.options.handlers[type] as CommandHandler<C>;
    try {
      const data = await handler(payload, { clientId: client.id, grant: client.grant });
      this.respond(client.socket, id, data);
    } catch (err) {
      const details = (err as { details?: unknown } | null)?.details;
      this.sendError(client.socket, id, {
        code: ErrorCodes.HandlerError,
        message: err instanceof Error ? err.message : String(err),
        ...(details !== undefined ? { details } : {}),
      });
    }
  }

  /**
   * Subscribes to every allowed event and reports the denied ones. Allowed
   * events in the same batch still apply, because clients re-send all their
   * subscriptions in one batch after a reconnect.
   */
  private handleSubscription(
    client: ClientState,
    id: string,
    type: SubscriptionCommand,
    payload: ParsedCommandRequest<SubscriptionCommand>,
  ): void {
    if (type === 'unsubscribe') {
      for (const event of payload.events) client.subscriptions.delete(event);
      this.respond(client.socket, id, { ok: true });
      return;
    }
    const denied: { event: string; reason: string }[] = [];
    for (const event of payload.events) {
      const reason = subscriptionDenial(client.grant, event);
      if (reason) denied.push({ event, reason });
      else client.subscriptions.add(event);
    }
    if (denied.length === 0) {
      this.respond(client.socket, id, { ok: true });
      return;
    }
    const events = denied.map((d) => d.event);
    this.log.warn('subscription denied', { clientId: client.id, denied });
    this.sendError(client.socket, id, {
      code: ErrorCodes.Forbidden,
      message: `Not allowed to subscribe to ${denied.map((d) => `${d.event} (${d.reason})`).join(', ')}`,
      details: { denied: events },
    });
  }

  private deliver(event: string, payload: unknown, meta: EventMeta): void {
    let message: string | null = null;
    for (const client of this.clients.values()) {
      if (client.id === meta.origin) continue;
      if (!isSubscribed(client.subscriptions, event)) continue;
      if (!canReceive(client.grant, event, payload)) continue;
      message ??= JSON.stringify({ v: PROTOCOL_VERSION, type: event, payload, ts: meta.timestamp });
      try {
        client.socket.send(message);
      } catch {
        // The socket closed between the check and the send.
      }
    }
  }

  private deny(client: ClientState, id: string, message: string): void {
    this.log.warn('command denied', { clientId: client.id, reason: message });
    this.sendError(client.socket, id, { code: ErrorCodes.Forbidden, message });
  }

  private respond(socket: ServerWebSocket<ClientData>, requestId: string, data: unknown): void {
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

  private send(socket: ServerWebSocket<ClientData>, message: unknown): void {
    try {
      socket.send(JSON.stringify(message));
    } catch {
      // The socket closed.
    }
  }
}

function isSubscribed(subscriptions: ReadonlySet<string>, event: string): boolean {
  if (subscriptions.size === 0) return false;
  if (subscriptions.has(event) || subscriptions.has('*')) return true;
  const colon = event.indexOf(':');
  return colon !== -1 && subscriptions.has(`${event.slice(0, colon)}:*`);
}

function requestIdOf(json: unknown): string {
  const id = (json as { id?: unknown } | null)?.id;
  return typeof id === 'string' ? id : '';
}

function describeScope(scope: TokenScope): string {
  return scope.kind === 'dashboard' ? 'dashboard' : `app ${scope.slugs.join('+')}`;
}
