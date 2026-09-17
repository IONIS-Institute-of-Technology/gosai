/**
 * The bridge of one app's drivers, as the driver manager sees it.
 *
 * Inside the app's bridge process drivers keep the plain names their classes
 * declare (`counter`). Everywhere else they are `<app slug>/<driver>`
 * (`hello-gosai/counter`), so they can't collide with built-in drivers or
 * another app's. This wrapper renames drivers on the way in and out, so a
 * `DriverManager` runs app drivers exactly like built-in ones: same leases,
 * lifecycle, supervisor, schemas and catalogue.
 */

import { appDriverName } from '@gosai/shared/driver-names';
import type { BridgeInstanceList } from '@gosai/shared/protocol';
import type {
  BridgeHandlers,
  BridgeRequestSansId,
  DriverBridge,
  DriverBridgeFactory,
  RequestOptions,
} from './bridge.js';
import type { DriverManifestEntry } from './manager.js';

/** Wraps `factory` so the bridge it makes names its drivers `<appSlug>/<driver>`. */
export function appBridgeFactory(
  appSlug: string,
  factory: DriverBridgeFactory,
): DriverBridgeFactory {
  const prefix = `${appSlug}/`;
  const qualify = (name: string): string => appDriverName(appSlug, name);
  const local = (name: string): string =>
    name.startsWith(prefix) ? name.slice(prefix.length) : name;

  return (handlers: BridgeHandlers): DriverBridge => {
    const bridge = factory({
      onEvent: (instance, driver, event, data, ts) =>
        handlers.onEvent(instance, qualify(driver), event, data, ts),
      // Log sources are driver names, or `bridge` for the process itself.
      onLog: (level, source, message, instance) =>
        handlers.onLog(level, qualify(source), message, instance),
      onDriverState: (instance, driver, state, runtime) =>
        handlers.onDriverState(instance, qualify(driver), state, runtime),
      onPerformance: (sample) =>
        handlers.onPerformance({ ...sample, source: qualify(sample.source) }),
      onExit: (code, signal) => handlers.onExit(code, signal),
    });

    return {
      start: () => bridge.start(),
      stop: () => bridge.stop(),
      isRunning: () => bridge.isRunning(),
      ping: (timeoutMs) => bridge.ping(timeoutMs),
      async request<T = unknown>(req: BridgeRequestSansId, options?: RequestOptions): Promise<T> {
        const inner = (
          'driver' in req ? { ...req, driver: local(req.driver) } : req
        ) as BridgeRequestSansId;
        const result = await bridge.request<unknown>(inner, options);
        switch (req.type) {
          case 'list-drivers': {
            const { drivers } = result as { drivers: readonly DriverManifestEntry[] };
            return {
              drivers: drivers.map((entry) => ({
                ...entry,
                name: qualify(entry.name),
                dependencies: entry.dependencies.map(qualify),
              })),
            } as T;
          }
          case 'list-instances': {
            const { instances } = result as BridgeInstanceList;
            return {
              instances: instances.map((item) => ({ ...item, driver: qualify(item.driver) })),
            } as T;
          }
          default:
            return result as T;
        }
      },
    };
  };
}
