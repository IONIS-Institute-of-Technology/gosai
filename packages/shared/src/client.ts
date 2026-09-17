/**
 * The one WebSocket client for the GOSAI server. The dashboard, Electron main
 * and the SDK runtime all use it; it runs wherever a WHATWG `WebSocket` exists
 * (browsers, Node 22+, Bun, Electron main).
 *
 * Reconnects:
 * - After a lost connection it reconnects with backoff. Only the current
 *   socket's events count, so a late `close` from an old socket can't tear
 *   down its replacement.
 * - Requests still waiting when the socket closes reject with
 *   {@link ConnectionClosedError} instead of waiting for their timeout.
 * - The server forgets a client's subscriptions when it disconnects. Once the
 *   server welcomes the new socket, the client re-sends every event
 *   subscription in one batch and re-acquires every {@link ServerClient.retain}ed
 *   resource, such as driver subscriptions.
 *
 * Event listeners for the same event share one server subscription, and
 * retained resources with the same key share one acquisition; the server hears
 * about the first and the last holder only. Errors thrown by listeners or
 * returned by background requests go to {@link ServerClient.onError}.
 */

import { COMMANDS, DEFAULT_REQUEST_TIMEOUT_MS } from './commands.js';
import {
  PROTOCOL_VERSION,
  type CommandName,
  type CommandRequest,
  type CommandResponse,
  type ErrorPayload,
  type EventPayload,
  type ResponsePayload,
  type WelcomePayload,
} from './protocol.js';

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';

/** The part of the WHATWG WebSocket the client uses. */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: 'open' | 'close' | 'error' | 'message',
    listener: (event: { readonly data?: unknown }) => void,
  ): void;
}

export interface ServerClientOptions {
  /** `ws://host:port/ws`. */
  readonly url: string;
  /** Sent as `?token=` because browsers can't set headers on a WebSocket. */
  readonly token?: string;
  /** Opens sockets. Defaults to the global `WebSocket`. */
  readonly createSocket?: (url: string) => WebSocketLike;
  /** First reconnect delay; it doubles up to `maxReconnectDelayMs`. */
  readonly reconnectDelayMs?: number;
  readonly maxReconnectDelayMs?: number;
}

export interface RequestOptions {
  /** Overrides the command's default timeout. */
  readonly timeoutMs?: number;
}

type RequestArgs<C extends CommandName> =
  Record<string, never> extends CommandRequest<C>
    ? [payload?: CommandRequest<C>, options?: RequestOptions]
    : [payload: CommandRequest<C>, options?: RequestOptions];

/** A server-side resource the client keeps while anyone holds it. */
export interface RetainableResource {
  acquire(): Promise<void>;
  release(): Promise<void>;
}

export interface RetainedResource {
  /** Settles with the first acquisition attempt. */
  readonly ready: Promise<void>;
  /** Drops this hold. The resource is released when the last hold goes. */
  release(): void;
}

export type ClientErrorListener = (error: unknown, context: string) => void;

export class NotConnectedError extends Error {
  constructor(message = 'Server not connected') {
    super(message);
    this.name = 'NotConnectedError';
  }
}

export class ConnectionClosedError extends NotConnectedError {
  constructor(message = 'Connection closed before the server replied') {
    super(message);
    this.name = 'ConnectionClosedError';
  }
}

export class RequestTimeoutError extends Error {
  constructor(readonly command: string) {
    super(`Request ${command} timed out`);
    this.name = 'RequestTimeoutError';
  }
}

/** The server answered with an error. */
export class ServerRequestError extends Error {
  readonly code: ErrorPayload['code'];
  readonly details: unknown;

  constructor(
    readonly command: string,
    error: ErrorPayload,
  ) {
    super(error.message);
    this.name = 'ServerRequestError';
    this.code = error.code;
    this.details = error.details;
  }
}

/** True for errors caused by a missing or lost connection. */
export function isNotConnectedError(err: unknown): err is NotConnectedError {
  return err instanceof NotConnectedError;
}

const SOCKET_OPEN = 1;
const DEFAULT_RECONNECT_DELAY_MS = 500;
const DEFAULT_MAX_RECONNECT_DELAY_MS = 5_000;

interface PendingRequest {
  readonly command: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (err: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface Holding {
  readonly resource: RetainableResource;
  count: number;
  readonly ready: Promise<void>;
  settle: { resolve: () => void; reject: (err: unknown) => void } | null;
}

type Listener = (payload: never) => void;

export class ServerClient {
  private socket: WebSocketLike | null = null;
  private currentStatus: ConnectionStatus = 'disconnected';
  private welcome: WelcomePayload | null = null;
  private closed = true;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay: number;
  private nextRequestId = 1;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly statusListeners = new Set<(status: ConnectionStatus) => void>();
  private readonly errorListeners = new Set<ClientErrorListener>();
  private readonly holdings = new Map<string, Holding>();
  /** Last queued acquire or release per retained key, so they reach the server in order. */
  private readonly retainQueues = new Map<string, Promise<void>>();

  constructor(private readonly options: ServerClientOptions) {
    this.reconnectDelay = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
  }

  get authToken(): string | undefined {
    return this.options.token;
  }

  get status(): ConnectionStatus {
    return this.currentStatus;
  }

  /** What the server said when this connection opened, or `null` while disconnected. */
  get serverInfo(): WelcomePayload | null {
    return this.welcome;
  }

  connected(): boolean {
    return this.currentStatus === 'connected';
  }

  connect(): void {
    this.closed = false;
    if (this.socket || this.reconnectTimer) return;
    this.openSocket();
  }

  /** Disconnects for good. Pending requests reject; call `connect()` to start over. */
  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.socket;
    this.socket = null;
    this.welcome = null;
    if (socket) {
      try {
        socket.close();
      } catch {
        // Already closing.
      }
    }
    this.rejectPending(new ConnectionClosedError('Client closed'));
    this.setStatus('disconnected');
  }

  /** Resolves once connected. Rejects after `timeoutMs` or when the client is closed. */
  ready(timeoutMs = 10_000): Promise<void> {
    if (this.connected()) return Promise.resolve();
    if (this.closed) return Promise.reject(new NotConnectedError('Client closed'));
    return new Promise((resolve, reject) => {
      const listener = (status: ConnectionStatus): void => {
        if (status === 'connected') finish(null);
        else if (this.closed) finish(new NotConnectedError('Client closed'));
      };
      const timer = setTimeout(
        () => finish(new NotConnectedError('Timed out connecting to the GOSAI server')),
        timeoutMs,
      );
      const finish = (err: Error | null): void => {
        clearTimeout(timer);
        this.statusListeners.delete(listener);
        if (err) reject(err);
        else resolve();
      };
      this.statusListeners.add(listener);
    });
  }

  /** Calls `listener` with the current status and every change. */
  onStatus(listener: (status: ConnectionStatus) => void): () => void {
    this.statusListeners.add(listener);
    this.safely(() => listener(this.currentStatus), 'status listener');
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  /**
   * Receives listener exceptions and failed background requests (subscribe,
   * retained resources). Without any error listener they go to `console.error`.
   */
  onError(listener: ClientErrorListener): () => void {
    this.errorListeners.add(listener);
    return () => {
      this.errorListeners.delete(listener);
    };
  }

  request<C extends CommandName>(type: C, ...args: RequestArgs<C>): Promise<CommandResponse<C>> {
    const [payload, options] = args;
    const socket = this.socket;
    if (!socket || !this.connected() || socket.readyState !== SOCKET_OPEN) {
      return Promise.reject(new NotConnectedError(`Server not connected (${this.currentStatus})`));
    }
    const id = String(this.nextRequestId++);
    const timeoutMs = options?.timeoutMs ?? COMMANDS[type].timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    return new Promise<CommandResponse<C>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RequestTimeoutError(type));
      }, timeoutMs);
      this.pending.set(id, {
        command: type,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      try {
        socket.send(JSON.stringify({ v: PROTOCOL_VERSION, id, type, payload: payload ?? {} }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Listens to an event name, `<namespace>:*` or `*`. The first listener for a
   * name subscribes on the server and the last one to leave unsubscribes.
   */
  on<E extends string>(event: E, listener: (payload: EventPayload<E>) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
      this.sendSubscription('subscribe', [event]);
    }
    const entry = listener as Listener;
    set.add(entry);
    return () => {
      const current = this.listeners.get(event);
      if (!current?.delete(entry) || current.size > 0) return;
      this.listeners.delete(event);
      this.sendSubscription('unsubscribe', [event]);
    };
  }

  /**
   * Keeps a server-side resource while at least one hold exists. The first
   * hold acquires it, the last release releases it, and every reconnect
   * acquires it again, because the server drops per-connection state. Holds
   * with the same `key` share the resource.
   */
  retain(key: string, resource: RetainableResource): RetainedResource {
    let holding = this.holdings.get(key);
    if (holding) {
      holding.count += 1;
    } else {
      const settle: NonNullable<Holding['settle']> = { resolve: () => {}, reject: () => {} };
      const ready = new Promise<void>((resolve, reject) => {
        settle.resolve = resolve;
        settle.reject = reject;
      });
      // Callers may ignore `ready`; failures also reach onError.
      ready.catch(() => undefined);
      const created: Holding = { resource, count: 1, ready, settle };
      holding = created;
      this.holdings.set(key, created);
      if (this.connected()) this.acquire(key, created);
    }
    const held = holding;
    let released = false;
    return {
      ready: held.ready,
      release: () => {
        if (released) return;
        released = true;
        held.count -= 1;
        if (held.count > 0 || this.holdings.get(key) !== held) return;
        this.holdings.delete(key);
        if (!this.connected()) return;
        this.enqueue(key, async () => {
          try {
            await held.resource.release();
          } catch (err) {
            if (!isNotConnectedError(err)) this.report(err, `releasing ${key}`);
          }
        });
      },
    };
  }

  private acquire(key: string, holding: Holding): void {
    this.enqueue(key, async () => {
      if (this.holdings.get(key) !== holding) return;
      try {
        await holding.resource.acquire();
        holding.settle?.resolve();
      } catch (err) {
        holding.settle?.reject(err);
        // A lost connection retries on reconnect; anything else is worth reporting.
        if (!isNotConnectedError(err)) this.report(err, `acquiring ${key}`);
      } finally {
        holding.settle = null;
      }
    });
  }

  private enqueue(key: string, operation: () => Promise<void>): void {
    const previous = this.retainQueues.get(key) ?? Promise.resolve();
    const next = previous.then(operation);
    this.retainQueues.set(key, next);
    void next.then(() => {
      if (this.retainQueues.get(key) === next) this.retainQueues.delete(key);
    });
  }

  private openSocket(): void {
    this.setStatus('connecting');
    let socket: WebSocketLike;
    try {
      const create = this.options.createSocket ?? ((url: string) => new WebSocket(url));
      socket = create(socketUrl(this.options.url, this.options.token));
    } catch (err) {
      this.report(err, 'opening the WebSocket');
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.addEventListener('message', (event) => {
      if (socket === this.socket) this.handleMessage(event.data);
    });
    socket.addEventListener('close', () => {
      if (socket === this.socket) this.handleClose();
    });
    socket.addEventListener('error', () => {
      // A close event follows and schedules the reconnect.
    });
  }

  private handleClose(): void {
    this.socket = null;
    this.welcome = null;
    this.rejectPending(new ConnectionClosedError());
    this.setStatus('disconnected');
    if (!this.closed) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.closed) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(
      delay * 2,
      this.options.maxReconnectDelayMs ?? DEFAULT_MAX_RECONNECT_DELAY_MS,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closed) this.openSocket();
    }, delay);
  }

  private handleMessage(raw: unknown): void {
    let message: { type?: unknown; payload?: unknown };
    try {
      message = JSON.parse(String(raw)) as typeof message;
    } catch (err) {
      this.report(err, 'parsing a server message');
      return;
    }
    if (typeof message?.type !== 'string') return;
    if (message.type === 'response') {
      this.handleResponse(message.payload as ResponsePayload);
    } else if (message.type === 'server:welcome') {
      this.handleWelcome(message.payload as WelcomePayload);
    } else {
      this.dispatch(message.type, message.payload);
    }
  }

  private handleWelcome(welcome: WelcomePayload): void {
    this.welcome = welcome;
    this.reconnectDelay = this.options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
    const events = Array.from(this.listeners.keys());
    this.setStatus('connected');
    if (events.length > 0) this.sendSubscription('subscribe', events);
    for (const [key, holding] of this.holdings) this.acquire(key, holding);
    this.dispatch('server:welcome', welcome);
  }

  private handleResponse(payload: ResponsePayload | undefined): void {
    if (!payload || typeof payload.requestId !== 'string') return;
    const pending = this.pending.get(payload.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(payload.requestId);
    if (payload.ok) pending.resolve(payload.data);
    else pending.reject(new ServerRequestError(pending.command, payload.error));
  }

  private sendSubscription(type: 'subscribe' | 'unsubscribe', events: string[]): void {
    if (!this.connected()) return;
    this.request(type, { events }).catch((err: unknown) => {
      if (!isNotConnectedError(err)) this.report(err, `${type} ${events.join(', ')}`);
    });
  }

  private dispatch(event: string, payload: unknown): void {
    this.fire(event, event, payload);
    const colon = event.indexOf(':');
    if (colon !== -1) this.fire(`${event.slice(0, colon)}:*`, event, payload);
    this.fire('*', event, payload);
  }

  private fire(pattern: string, event: string, payload: unknown): void {
    const set = this.listeners.get(pattern);
    if (!set) return;
    for (const listener of Array.from(set)) {
      this.safely(() => (listener as (payload: unknown) => void)(payload), `listener for ${event}`);
    }
  }

  private rejectPending(err: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
  }

  private setStatus(status: ConnectionStatus): void {
    if (status === this.currentStatus) return;
    this.currentStatus = status;
    for (const listener of Array.from(this.statusListeners)) {
      this.safely(() => listener(status), 'status listener');
    }
  }

  private safely(run: () => void, context: string): void {
    try {
      run();
    } catch (err) {
      this.report(err, context);
    }
  }

  private report(error: unknown, context: string): void {
    if (this.errorListeners.size === 0) {
      console.error(`[gosai] ${context} failed`, error);
      return;
    }
    for (const listener of Array.from(this.errorListeners)) {
      try {
        listener(error, context);
      } catch (err) {
        console.error('[gosai] client error listener failed', err);
      }
    }
  }
}

function socketUrl(url: string, token: string | undefined): string {
  if (!token) return url;
  const parsed = new URL(url);
  parsed.searchParams.set('token', token);
  return parsed.toString();
}
