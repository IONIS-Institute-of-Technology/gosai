/**
 * App-scoped pub/sub used by multi-window experiences. The server's
 * `app:broadcast` handler emits `app:<slug>:<topic>` on the bus and every
 * other connected client subscribed to that topic receives the payload.
 *
 * This is intentionally tiny -- no acknowledgements, no replay. If a window
 * misses an event because it connected late, it must read whatever state
 * matters (e.g. via `rt.storage` or the publisher re-broadcasting).
 */

import { appEventName } from '@gosai/shared/events';
import type { AppEventsClient, AppEventsSubscription, ServerConnection } from './types.js';

export class AppEventsClientImpl implements AppEventsClient {
  constructor(
    private readonly appSlug: string,
    private readonly server: ServerConnection,
  ) {}

  emit(topic: string, data?: unknown): Promise<void> {
    return this.server
      .request('app:broadcast', { appSlug: this.appSlug, topic, data: data ?? null })
      .then(() => undefined);
  }

  on(topic: string, listener: (data: unknown) => void): AppEventsSubscription {
    return { unsubscribe: this.server.on(appEventName(this.appSlug, topic), listener) };
  }
}
