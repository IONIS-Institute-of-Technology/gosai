/**
 * In-process event bus. Used by every server-side component (drivers, app
 * manager, system monitor, IPC) to publish events. The WebSocket gateway
 * subscribes here and forwards events to clients based on their subscriptions.
 */

import type { EventPayload } from '@gosai/shared/protocol';

export type EventListener = (event: string, payload: unknown, meta: EventMeta) => void;

export interface EventMeta {
  readonly timestamp: number;
  readonly source: string;
  /** Client whose command caused the event. The gateway doesn't echo it back. */
  readonly origin?: string;
}

export interface EventBusOptions {
  /** Receives listener exceptions. Defaults to `console.error`. */
  readonly onListenerError?: (err: unknown, event: string) => void;
}

type Unsubscribe = () => void;

const WILDCARD = '*';

export class EventBus {
  private readonly listeners = new Map<string, Set<EventListener>>();
  private reportingError = false;

  constructor(private readonly options: EventBusOptions = {}) {}

  /**
   * Subscribe to a specific event name, a wildcard like `driver:*`, or `*`
   * (which receives every event).
   */
  on(pattern: string, listener: EventListener): Unsubscribe {
    let set = this.listeners.get(pattern);
    if (!set) {
      set = new Set();
      this.listeners.set(pattern, set);
    }
    const listeners = set;
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0 && this.listeners.get(pattern) === listeners) {
        this.listeners.delete(pattern);
      }
    };
  }

  emit<E extends string>(
    event: E,
    payload: EventPayload<E>,
    source = 'system',
    origin?: string,
  ): void {
    const meta: EventMeta = {
      timestamp: Date.now(),
      source,
      ...(origin !== undefined ? { origin } : {}),
    };
    this.dispatch(event, payload, meta, event);
    const colon = event.indexOf(':');
    if (colon !== -1) this.dispatch(event, payload, meta, `${event.slice(0, colon)}:*`);
    this.dispatch(event, payload, meta, WILDCARD);
  }

  private dispatch(event: string, payload: unknown, meta: EventMeta, pattern: string): void {
    const set = this.listeners.get(pattern);
    if (!set) return;
    for (const listener of set) {
      try {
        listener(event, payload, meta);
      } catch (err) {
        this.reportListenerError(err, event);
      }
    }
  }

  private reportListenerError(err: unknown, event: string): void {
    // A reporter that logs emits `server:log`; don't recurse if that fails too.
    if (this.reportingError || !this.options.onListenerError) {
      console.error(`[gosai] listener for ${event} failed`, err);
      return;
    }
    this.reportingError = true;
    try {
      this.options.onListenerError(err, event);
    } finally {
      this.reportingError = false;
    }
  }
}
