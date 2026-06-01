import type { DriverClient, DriverSubscription, ServerConnection } from './types.js';

/**
 * Driver client scoped to a single app binding (the app slug). Subscriptions
 * carry the binding so the server routes this app to its own driver instances,
 * and events arrive on the per-binding topic `driver:event:<binding>` so the app
 * only ever sees its own stream.
 */
export class DriverClientImpl implements DriverClient {
  private readonly eventTopic: string;

  constructor(
    private readonly server: ServerConnection,
    private readonly binding: string,
  ) {
    this.eventTopic = `driver:event:${binding}`;
  }

  on(driver: string, event: string, listener: (data: unknown) => void): DriverSubscription {
    let unsubServer: (() => void) | null = null;

    void (async () => {
      try {
        await this.server.request('driver:subscribe', { driver, event, binding: this.binding });
      } catch {
        // The driver event listener is still wired; subscription may eventually
        // succeed on reconnect.
      }
    })();

    unsubServer = this.server.on(this.eventTopic, (payload) => {
      const data = payload as { driver: string; event: string; data: unknown };
      if (data.driver !== driver) return;
      if (event !== '*' && data.event !== event) return;
      try {
        listener(data.data);
      } catch (err) {
        console.error(`driver listener for ${driver}.${event} failed`, err);
      }
    });

    return {
      unsubscribe: () => {
        if (unsubServer) unsubServer();
        void this.server
          .request('driver:unsubscribe', { driver, event, binding: this.binding })
          .catch(() => undefined);
      },
    };
  }

  async get(driver: string, event: string): Promise<unknown> {
    return this.server.request('driver:get-data', { driver, event, binding: this.binding });
  }

  async execute(driver: string, action: string, data?: unknown): Promise<unknown> {
    return this.server.request('driver:execute', {
      driver,
      action,
      data,
      binding: this.binding,
    });
  }
}
