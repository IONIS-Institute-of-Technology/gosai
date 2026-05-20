import type { DriverClient, DriverSubscription, ServerConnection } from './types.js';

export class DriverClientImpl implements DriverClient {
  constructor(private readonly server: ServerConnection) {}

  on(driver: string, event: string, listener: (data: unknown) => void): DriverSubscription {
    let unsubServer: (() => void) | null = null;

    void (async () => {
      try {
        await this.server.request('driver:subscribe', { driver, event });
      } catch {
        // The driver event listener is still wired; subscription may eventually
        // succeed on reconnect.
      }
    })();

    unsubServer = this.server.on('driver:event', (payload) => {
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
        void this.server.request('driver:unsubscribe', { driver, event }).catch(() => undefined);
      },
    };
  }

  async get(driver: string, event: string): Promise<unknown> {
    return this.server.request('driver:get-data', { driver, event });
  }

  async execute(driver: string, action: string, data?: unknown): Promise<unknown> {
    return this.server.request('driver:execute', { driver, action, data });
  }
}
