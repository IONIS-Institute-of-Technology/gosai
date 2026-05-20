/**
 * Minimal WebSocket client used by the SDK runtime to talk to the GOSAI server.
 * Mirrors the desktop ServerClient but lives in the SDK so apps don't need to
 * depend on the desktop package.
 */

import { PROTOCOL_VERSION } from '@gosai/shared/protocol';
import type { ServerConnection } from './types.js';

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';

const RECONNECT_DELAY_MS = 1000;
const REQUEST_TIMEOUT_MS = 10_000;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface ServerClientOptions {
  readonly url: string;
}

export class ServerClient implements ServerConnection {
  private ws: WebSocket | null = null;
  private status: ConnectionStatus = 'disconnected';
  private readonly listeners = new Map<string, Set<(payload: unknown) => void>>();
  private readonly statusListeners = new Set<(s: ConnectionStatus) => void>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly subscribedEvents = new Set<string>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(private readonly options: ServerClientOptions) {}

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

  connected(): boolean {
    return this.status === 'connected';
  }

  onStatus(listener: (s: ConnectionStatus) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => this.statusListeners.delete(listener);
  }

  on(event: string, listener: (payload: unknown) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
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
        reject(new Error(`Server not connected (status=${this.status})`));
        return;
      }
      const id = randomId();
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

  private openSocket(): void {
    this.setStatus('connecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.options.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.addEventListener('open', () => {
      this.setStatus('connected');
      if (this.subscribedEvents.size > 0) {
        this.send({
          v: PROTOCOL_VERSION,
          type: 'subscribe',
          payload: { events: Array.from(this.subscribedEvents) },
        });
      }
    });
    ws.addEventListener('close', () => {
      this.ws = null;
      this.setStatus('disconnected');
      if (!this.closed) this.scheduleReconnect();
    });
    ws.addEventListener('error', () => {
      // close handler will reconnect
    });
    ws.addEventListener('message', (ev) => this.handleMessage(ev));
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closed) this.openSocket();
    }, RECONNECT_DELAY_MS);
  }

  private subscribe(event: string): void {
    this.subscribedEvents.add(event);
    this.send({
      v: PROTOCOL_VERSION,
      type: 'subscribe',
      payload: { events: [event] },
    });
  }

  private unsubscribe(event: string): void {
    this.subscribedEvents.delete(event);
    this.send({
      v: PROTOCOL_VERSION,
      type: 'unsubscribe',
      payload: { events: [event] },
    });
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
    this.fire(event, payload);
    const colon = event.indexOf(':');
    if (colon !== -1) this.fire(`${event.slice(0, colon)}:*`, payload);
    this.fire('*', payload);
  }

  private fire(event: string, payload: unknown): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const l of set) {
      try {
        l(payload);
      } catch {
        // ignore
      }
    }
  }

  private setStatus(s: ConnectionStatus): void {
    if (s === this.status) return;
    this.status = s;
    for (const l of this.statusListeners) {
      try {
        l(s);
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

function randomId(): string {
  return crypto.randomUUID();
}
