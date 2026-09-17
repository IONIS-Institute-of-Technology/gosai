import { driverEventName } from '@gosai/shared/events';
import type {
  DriverAction,
  DriverActionArgs,
  DriverActionResult,
  DriverEvent,
  DriverEventData,
  DriverName,
} from './driver-types.js';
import type { DriverClient, DriverSubscription, ServerConnection } from './types.js';

/**
 * Driver client scoped to a single app binding (the app slug). Subscriptions
 * carry the binding so the server routes this app to its own driver instances,
 * and events arrive on the per-binding topic `driver:event:<binding>` so the app
 * only ever sees its own stream.
 *
 * Listeners for the same driver event share one server subscription. The
 * client keeps it across reconnects and releases it when the last listener
 * unsubscribes.
 */
export class DriverClientImpl implements DriverClient {
  constructor(
    private readonly server: ServerConnection,
    private readonly binding: string,
  ) {}

  on<D extends DriverName, E extends DriverEvent<D> | '*'>(
    driver: D,
    event: E,
    listener: (data: DriverEventData<D, E>) => void,
  ): DriverSubscription {
    const target = { driver, event, binding: this.binding };
    const held = this.server.retain(`driver:${this.binding}:${driver}:${event}`, {
      acquire: async () => {
        await this.server.request('driver:subscribe', target);
      },
      release: async () => {
        await this.server.request('driver:unsubscribe', target);
      },
    });
    const off = this.server.on(driverEventName(this.binding), (payload) => {
      if (payload.driver !== driver) return;
      if (event !== '*' && payload.event !== event) return;
      listener(payload.data as DriverEventData<D, E>);
    });

    let active = true;
    return {
      ready: held.ready,
      unsubscribe: () => {
        if (!active) return;
        active = false;
        off();
        held.release();
      },
    };
  }

  async get<D extends DriverName, E extends DriverEvent<D>>(
    driver: D,
    event: E,
  ): Promise<DriverEventData<D, E> | null> {
    const data = await this.server.request('driver:get-data', {
      driver,
      event,
      binding: this.binding,
    });
    return (data ?? null) as DriverEventData<D, E> | null;
  }

  async execute<D extends DriverName, A extends DriverAction<D>>(
    driver: D,
    action: A,
    ...params: DriverActionArgs<D, A>
  ): Promise<DriverActionResult<D, A>> {
    return (await this.server.request('driver:execute', {
      driver,
      action,
      data: params[0],
      binding: this.binding,
    })) as DriverActionResult<D, A>;
  }
}
