/**
 * In-process event bus. Used by every server-side component (drivers, app
 * manager, system monitor, IPC) to publish events. The WebSocket gateway
 * subscribes here and forwards events to clients based on their subscriptions.
 */

export type EventListener = (event: string, payload: unknown, meta: EventMeta) => void;

export interface EventMeta {
  readonly timestamp: number;
  readonly source: string;
}

type Unsubscribe = () => void;

interface EventEnvelope {
  readonly event: string;
  readonly payload: unknown;
  readonly meta: EventMeta;
}

const WILDCARD = '*';

export class EventBus {
  private readonly listeners = new Map<string, Set<EventListener>>();

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
    set.add(listener);
    return () => {
      set!.delete(listener);
      if (set!.size === 0) this.listeners.delete(pattern);
    };
  }

  emit(event: string, payload: unknown, source = 'system'): void {
    const meta: EventMeta = { timestamp: Date.now(), source };
    const envelope: EventEnvelope = { event, payload, meta };
    this.dispatch(envelope, event);
    const colon = event.indexOf(':');
    if (colon !== -1) {
      this.dispatch(envelope, `${event.slice(0, colon)}:*`);
    }
    this.dispatch(envelope, WILDCARD);
  }

  private dispatch(envelope: EventEnvelope, pattern: string): void {
    const set = this.listeners.get(pattern);
    if (!set) return;
    for (const listener of set) {
      try {
        listener(envelope.event, envelope.payload, envelope.meta);
      } catch {
        // Listener errors must never propagate.
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}
