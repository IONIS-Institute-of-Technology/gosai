/**
 * Every driver the server runs: the built-in drivers in GOSAI's own bridge,
 * and the drivers of each app that ships some (the manifest's `python`), each
 * app in a bridge process and Python environment of its own. A crash, a hang
 * or a dependency conflict in an app's drivers stays in that app's process: its
 * supervisor restarts it while the built-in drivers and other apps' drivers
 * keep running.
 *
 * Each bridge has its own `DriverManager`, so app drivers get the same leases,
 * lifecycle, restarts, schemas and catalogue entries as built-in drivers. The
 * hub routes each call by driver name, `<app>/<driver>` to that app's manager
 * and plain names to the built-in one, and lists and describes the drivers of
 * every manager together.
 *
 * Any app may use another app's drivers, like built-in ones. Access is checked
 * on the driver binding a request uses, never on the driver's name.
 *
 * Replacing or removing an app's bridge drops its leases. The app manager
 * stops the experiences that use the app's drivers first (see
 * `AppManager`), so none keeps running without events.
 */

import type {
  DeviceCatalog,
  DeviceOption,
  DriverInfo,
  DriverSchemasResult,
  PythonConfig,
} from '@gosai/shared';
import { splitDriverName } from '@gosai/shared/driver-names';
import { ServerEvents } from '@gosai/shared/events';
import type { EventBus } from '../ipc/bus.js';
import type { ChildLogger, Logger } from '../logger/logger.js';
import { appBridgeFactory } from './app-bridge.js';
import type { BridgeHandlers, DriverBridge, DriverBridgeFactory } from './bridge.js';
import { DriverManager, type DriverManagerOptions } from './manager.js';
import type { SupervisorTiming } from './supervisor.js';

/** What commands and the app manager need from drivers. `DriverManager` has it too. */
export type DriverService = Pick<
  DriverManager,
  | 'listDrivers'
  | 'getSchemas'
  | 'getDriver'
  | 'isInstanceRunning'
  | 'runningBindings'
  | 'subscribe'
  | 'unsubscribe'
  | 'unsubscribeAll'
  | 'getData'
  | 'execute'
  | 'listCameras'
  | 'listAudioDevices'
  | 'listDevices'
>;

/** An app that ships drivers. */
export interface AppDriverSource {
  readonly slug: string;
  readonly installPath: string;
  readonly builtin: boolean;
  readonly python: PythonConfig;
}

/** How the app manager keeps the hub in step with the installed apps. */
export interface AppDriverHosts {
  /**
   * Every app that ships drivers, after any change to the app catalogue. An
   * app whose source changed gets a new bridge; release the old one first.
   */
  sync(apps: readonly AppDriverSource[]): void;
  /**
   * Stops an app's drivers, and any build of its environment, before its
   * files are removed or replaced. Every lease on them is dropped.
   */
  release(slug: string): Promise<void>;
}

/** Identifies what an app's bridge runs; a new key means a new bridge. */
export function appDriverSourceKey(app: AppDriverSource): string {
  return JSON.stringify([
    app.installPath,
    app.builtin,
    app.python.drivers,
    app.python.requirements,
  ]);
}

/** How long a subscription waits for an app's environment before failing. */
const DEFAULT_PREPARE_WAIT_MS = 30_000;

/** Runs app drivers: see `pythonAppBridges` in app-drivers.ts. */
export interface AppBridgeProvider {
  /**
   * Builds or checks the app's environment. The first build can take minutes.
   * Rejects soon after `signal` aborts, with nothing left running.
   */
  prepare(app: AppDriverSource, signal: AbortSignal): Promise<void>;
  /** The bridge process of the app's drivers, which uses their unqualified names. */
  createBridge(app: AppDriverSource, handlers: BridgeHandlers): DriverBridge;
}

export interface DriverHubOptions {
  readonly logger: Logger;
  readonly bus: EventBus;
  readonly getDriverConfig?: DriverManagerOptions['getDriverConfig'];
  /** The Python project of the built-in bridge. */
  readonly pythonDir?: string;
  /** The built-in drivers' bridge. Defaults to `gosai-bridge` in `pythonDir`. */
  readonly createBridge?: DriverBridgeFactory;
  /** Without it, apps' drivers don't run and their names are unknown. */
  readonly apps?: AppBridgeProvider;
  /**
   * Why Python drivers can't run here at all, such as a missing Python
   * environment. The built-in bridge then never starts, and calls to built-in
   * drivers, or to app drivers when there is no `apps`, reject with it.
   */
  readonly unavailable?: string;
  readonly supervisorTiming?: Partial<SupervisorTiming>;
  readonly bridgeReadyWaitMs?: number;
  /**
   * How long a subscription to an app's driver waits for the app's
   * environment. The build goes on afterwards. Defaults to 30 s.
   */
  readonly prepareWaitMs?: number;
}

interface AppHost {
  readonly app: AppDriverSource;
  /** Changes when the app is reinstalled, moved or declares other drivers. */
  readonly key: string;
  readonly manager: DriverManager;
  /** Settles once the environment is ready, or failed to be. */
  prepared: Promise<void> | null;
  /** Settles once the environment is ready and the bridge started, or either failed. */
  ready: Promise<void> | null;
  /** Aborts the environment build. */
  abort: AbortController;
  /** Why the environment could not be prepared. A new subscription retries. */
  error: Error | null;
  removed: boolean;
}

export class DriverHub implements DriverService, AppDriverHosts {
  private readonly log: ChildLogger;
  private readonly builtin: DriverManager;
  private readonly hosts = new Map<string, AppHost>();
  private active = false;
  /** Why the built-in bridge's first start failed. It counts until the bridge comes up. */
  private builtinStartError: string | null = null;

  constructor(private readonly options: DriverHubOptions) {
    this.log = options.logger.child('drivers');
    this.builtin = new DriverManager({
      ...this.managerOptions(),
      ...(options.pythonDir !== undefined ? { pythonDir: options.pythonDir } : {}),
      ...(options.createBridge ? { createBridge: options.createBridge } : {}),
    });
  }

  /**
   * Starts the built-in bridge and the bridges of known apps. Rejects when the
   * built-in bridge's first attempt fails; every bridge keeps retrying. The
   * built-in bridge doesn't start when Python drivers are `unavailable`.
   */
  async start(): Promise<void> {
    this.active = true;
    for (const host of this.hosts.values()) void this.launch(host);
    if (this.options.unavailable !== undefined) return;
    try {
      await this.builtin.start();
    } catch (err) {
      this.builtinStartError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  /**
   * Why the built-in drivers can't be used: the `unavailable` option, or the
   * error of the built-in bridge's first start until the bridge comes up.
   * Null when they can, including while the bridge starts.
   */
  unavailableReason(): string | null {
    if (this.options.unavailable !== undefined) return this.options.unavailable;
    if (this.builtinStartError !== null && !this.builtin.hasStarted()) {
      return this.builtinStartError;
    }
    return null;
  }

  /** Stops every bridge, and kills environment builds and waits for them to end. */
  async stop(): Promise<void> {
    this.active = false;
    const hosts = Array.from(this.hosts.values());
    for (const host of hosts) host.abort.abort();
    await Promise.all([
      ...this.managers().map((manager) => manager.stop()),
      ...hosts.map((host) => host.ready),
    ]);
  }

  sync(apps: readonly AppDriverSource[]): void {
    if (!this.options.apps) return;
    const wanted = new Map(apps.map((app) => [app.slug, app]));
    let changed = false;
    for (const [slug, host] of this.hosts) {
      const app = wanted.get(slug);
      if (app && appDriverSourceKey(app) === host.key) continue;
      void this.removeHost(host);
      changed = true;
    }
    for (const app of wanted.values()) {
      if (this.hosts.has(app.slug)) continue;
      this.addHost(app);
      changed = true;
    }
    if (changed) this.broadcastList();
  }

  async release(slug: string): Promise<void> {
    const host = this.hosts.get(slug);
    if (!host) return;
    await this.removeHost(host);
    this.broadcastList();
  }

  listDrivers(): DriverInfo[] {
    return this.managers().flatMap((manager) => manager.listDrivers());
  }

  getSchemas(driver?: string): DriverSchemasResult {
    if (driver !== undefined) return this.route(driver).manager.getSchemas(driver);
    return {
      schemas: Object.assign({}, ...this.managers().map((manager) => manager.getSchemas().schemas)),
    };
  }

  getDriver(name: string): DriverInfo | undefined {
    return this.find(name)?.manager.getDriver(name);
  }

  isInstanceRunning(binding: string, driver: string): boolean {
    return this.find(driver)?.manager.isInstanceRunning(binding, driver) ?? false;
  }

  runningBindings(driver: string): string[] {
    return this.find(driver)?.manager.runningBindings(driver) ?? [];
  }

  async subscribe(binding: string, driver: string, event: string, client: string): Promise<void> {
    const { manager, host } = this.route(driver);
    if (host) await this.whenPrepared(host);
    await manager.subscribe(binding, driver, event, client);
  }

  async unsubscribe(binding: string, driver: string, event: string, client: string): Promise<void> {
    await this.find(driver)?.manager.unsubscribe(binding, driver, event, client);
  }

  async unsubscribeAll(client: string): Promise<void> {
    await Promise.all(this.managers().map((manager) => manager.unsubscribeAll(client)));
  }

  getData(binding: string, driver: string, event: string): Promise<unknown> {
    return this.route(driver).manager.getData(binding, driver, event);
  }

  execute(binding: string, driver: string, action: string, data: unknown): Promise<unknown> {
    return this.route(driver).manager.execute(binding, driver, action, data);
  }

  /** Devices are enumerated by the built-in bridge. */
  listCameras(): Promise<DeviceOption[]> {
    return this.builtin.listCameras();
  }

  listAudioDevices(): Promise<{ microphones: DeviceOption[]; speakers: DeviceOption[] }> {
    return this.builtin.listAudioDevices();
  }

  listDevices(): Promise<DeviceCatalog> {
    return this.builtin.listDevices();
  }

  private managerOptions(): DriverManagerOptions {
    const { options } = this;
    return {
      logger: options.logger,
      bus: options.bus,
      onListChanged: () => this.broadcastList(),
      ...(options.getDriverConfig ? { getDriverConfig: options.getDriverConfig } : {}),
      ...(options.supervisorTiming ? { supervisorTiming: options.supervisorTiming } : {}),
      ...(options.bridgeReadyWaitMs !== undefined
        ? { bridgeReadyWaitMs: options.bridgeReadyWaitMs }
        : {}),
    };
  }

  private addHost(app: AppDriverSource): void {
    const provider = this.options.apps;
    if (!provider) return;
    const host: AppHost = {
      app,
      key: appDriverSourceKey(app),
      manager: new DriverManager({
        ...this.managerOptions(),
        logSource: `drivers:${app.slug}`,
        createBridge: appBridgeFactory(app.slug, (handlers) =>
          provider.createBridge(app, handlers),
        ),
      }),
      prepared: null,
      ready: null,
      abort: new AbortController(),
      error: null,
      removed: false,
    };
    this.hosts.set(app.slug, host);
    if (this.active) void this.launch(host);
  }

  private async removeHost(host: AppHost): Promise<void> {
    host.removed = true;
    host.abort.abort();
    if (this.hosts.get(host.app.slug) === host) this.hosts.delete(host.app.slug);
    try {
      await Promise.all([host.manager.stop(), host.ready]);
    } catch (err) {
      this.log.warn('stopping app drivers failed', { app: host.app.slug, err: String(err) });
    }
  }

  /** Prepares the app's environment, then starts its bridge. */
  private launch(host: AppHost): Promise<void> {
    const provider = this.options.apps;
    if (!provider) return Promise.resolve();
    const { slug } = host.app;
    host.error = null;
    host.prepared = (async () => {
      try {
        await provider.prepare(host.app, host.abort.signal);
      } catch (err) {
        if (host.removed || host.abort.signal.aborted) return;
        host.error = err instanceof Error ? err : new Error(String(err));
        this.log.error('the python environment of app drivers could not be prepared', {
          app: slug,
          err: host.error.message,
        });
      }
    })();
    host.ready = (async () => {
      await host.prepared;
      if (host.error || host.removed || !this.active) return;
      this.log.info('starting app drivers', { app: slug });
      await host.manager.start().catch((err: unknown) => {
        this.log.warn('app driver bridge did not start; retrying', { app: slug, err: String(err) });
      });
    })();
    return host.ready;
  }

  /**
   * Waits for the app's environment, preparing it again after an earlier
   * failure. Gives up after `prepareWaitMs` while the build goes on, so a
   * client gets a clear error instead of its own timeout.
   */
  private async whenPrepared(host: AppHost): Promise<void> {
    if (!this.active) return;
    if (host.error) void this.launch(host);
    const waitMs = this.options.prepareWaitMs ?? DEFAULT_PREPARE_WAIT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const prepared = await Promise.race([
      (host.prepared ?? Promise.resolve()).then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), waitMs);
      }),
    ]);
    clearTimeout(timer);
    if (!prepared) {
      throw new Error(
        `Python environment for ${host.app.slug} is still being prepared; try again when it is ready`,
      );
    }
    if (host.error) {
      throw new Error(`the drivers of ${host.app.slug} are unavailable: ${host.error.message}`);
    }
  }

  private managers(): DriverManager[] {
    return [this.builtin, ...Array.from(this.hosts.values(), (host) => host.manager)];
  }

  private find(driver: string): { manager: DriverManager; host: AppHost | null } | null {
    const { app } = splitDriverName(driver);
    if (app === null) return { manager: this.builtin, host: null };
    const host = this.hosts.get(app);
    return host ? { manager: host.manager, host } : null;
  }

  private route(driver: string): { manager: DriverManager; host: AppHost | null } {
    const unavailable = this.unavailableFor(driver);
    if (unavailable !== null) throw new Error(`Python drivers are unavailable: ${unavailable}`);
    const found = this.find(driver);
    if (!found) throw new Error(`Unknown driver: ${driver}`);
    return found;
  }

  /** Why `driver` can't run at all. App drivers only depend on the Python toolchain. */
  private unavailableFor(driver: string): string | null {
    if (splitDriverName(driver).app === null) return this.unavailableReason();
    return this.options.apps ? null : (this.options.unavailable ?? null);
  }

  private broadcastList(): void {
    this.options.bus.emit(
      ServerEvents.DriversListChanged,
      { drivers: this.listDrivers() },
      'drivers',
    );
  }
}
