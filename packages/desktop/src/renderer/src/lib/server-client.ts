/**
 * Thin WebSocket client for the GOSAI server. Handles reconnect, subscriptions,
 * RPC, and event delivery.
 */

import { PROTOCOL_VERSION } from '@gosai/shared/protocol';

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';

export type EventListener = (payload: unknown) => void;

export class NotConnectedError extends Error {
  constructor() {
    super('Server not connected');
    this.name = 'NotConnectedError';
  }
}

export function isNotConnectedError(err: unknown): err is NotConnectedError {
  return err instanceof NotConnectedError;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const RECONNECT_DELAY_MS = 1000;
const REQUEST_TIMEOUT_MS = 10_000;

export interface ServerClientOptions {
  readonly url: string;
  readonly onStatusChange?: (status: ConnectionStatus) => void;
}

export class ServerClient {
  private ws: WebSocket | null = null;
  private status: ConnectionStatus = 'disconnected';
  private readonly listeners = new Map<string, Set<EventListener>>();
  private readonly pending = new Map<string, PendingRequest>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private readonly statusListeners = new Set<(s: ConnectionStatus) => void>();
  private subscribedEvents = new Set<string>();
  private clientId: string | null = null;

  constructor(private readonly options: ServerClientOptions) {
    if (options.onStatusChange) this.statusListeners.add(options.onStatusChange);
  }

  connect(): void {
    if (this.ws) return;
    this.closed = false;
    this.openSocket();
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
    for (const [id, req] of this.pending.entries()) {
      clearTimeout(req.timer);
      req.reject(new Error('Client closed'));
      this.pending.delete(id);
    }
  }

  onStatus(listener: (s: ConnectionStatus) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => this.statusListeners.delete(listener);
  }

  on(event: string, listener: EventListener): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
      // Lazily subscribe to the server.
      this.subscribe(event);
    }
    set.add(listener);
    return () => {
      set!.delete(listener);
      if (set!.size === 0) {
        this.listeners.delete(event);
        this.unsubscribe(event);
      }
    };
  }

  request<T = unknown>(type: string, payload: unknown = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new NotConnectedError());
        return;
      }
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request ${type} timed out`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      try {
        this.ws.send(JSON.stringify({ v: PROTOCOL_VERSION, id, type, payload }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  getClientId(): string | null {
    return this.clientId;
  }

  private openSocket(): void {
    this.setStatus('connecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.options.url);
    } catch (err) {
      console.error('failed to open WebSocket', err);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.addEventListener('open', () => {
      this.setStatus('connected');
      this.resubscribe();
    });
    ws.addEventListener('close', () => this.handleClose());
    ws.addEventListener('error', () => {
      // close handler will trigger reconnect
    });
    ws.addEventListener('message', (ev) => this.handleMessage(ev));
  }

  private handleClose(): void {
    this.ws = null;
    this.setStatus('disconnected');
    if (this.closed) return;
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closed) this.openSocket();
    }, RECONNECT_DELAY_MS);
  }

  private resubscribe(): void {
    if (this.subscribedEvents.size === 0) return;
    this.send({
      v: PROTOCOL_VERSION,
      type: 'subscribe',
      payload: { events: Array.from(this.subscribedEvents) },
    });
  }

  private subscribe(event: string): void {
    this.subscribedEvents.add(event);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.send({
        v: PROTOCOL_VERSION,
        type: 'subscribe',
        payload: { events: [event] },
      });
    }
  }

  private unsubscribe(event: string): void {
    this.subscribedEvents.delete(event);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.send({
        v: PROTOCOL_VERSION,
        type: 'unsubscribe',
        payload: { events: [event] },
      });
    }
  }

  private send(value: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify(value));
    } catch {
      // socket gone
    }
  }

  private handleMessage(ev: MessageEvent): void {
    let parsed: { type: string; payload?: unknown };
    try {
      parsed = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    if (parsed.type === 'response') {
      this.handleResponse(parsed.payload as ResponsePayload);
      return;
    }
    if (parsed.type === 'server:welcome') {
      const payload = parsed.payload as { clientId?: string } | undefined;
      this.clientId = payload?.clientId ?? null;
      return;
    }
    this.dispatchEvent(parsed.type, parsed.payload);
  }

  private handleResponse(payload: ResponsePayload | undefined): void {
    if (!payload || typeof payload !== 'object') return;
    const id = payload.requestId;
    if (!id) return;
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    if (payload.ok) {
      pending.resolve(payload.data);
    } else {
      pending.reject(new Error(payload.error?.message ?? 'Request failed'));
    }
  }

  private dispatchEvent(event: string, payload: unknown): void {
    this.fireListeners(event, payload);
    const colon = event.indexOf(':');
    if (colon !== -1) {
      this.fireListeners(`${event.slice(0, colon)}:*`, payload);
    }
    this.fireListeners('*', payload);
  }

  private fireListeners(event: string, payload: unknown): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of set) {
      try {
        listener(payload);
      } catch (err) {
        console.error('event listener failed', err);
      }
    }
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.status === status) return;
    this.status = status;
    for (const l of this.statusListeners) {
      try {
        l(status);
      } catch {
        // ignore
      }
    }
  }
}

interface ResponsePayload {
  requestId?: string;
  ok?: boolean;
  data?: unknown;
  error?: { code: string; message: string };
}
