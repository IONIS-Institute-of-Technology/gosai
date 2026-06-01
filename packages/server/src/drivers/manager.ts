/**
 * Driver manager. Talks to the Python bridge to start/stop drivers and route
 * driver events onto the in-process EventBus. Tracks per-instance driver state
 * and dependency relationships.
 *
 * Bindings & instances
 * ---------------------
 * A *binding* is an app slug (or `system` for dashboard diagnostics). Each
 * driver has a sharing policy: exclusive drivers (camera, microphone, anything
 * that depends on them) get one instance per binding; shared drivers (speaker,
 * device-less utilities) get a single instance shared across bindings, keyed by
 * device when device-bound.
 *
 * The catalogue (driver *types*) stays keyed by name. Running state and
 * subscribers gain an instance dimension: the instance namespace is the binding
 * for exclusive drivers, or `shared` / `shared:dev<n>` for shared ones. Driver
 * events fan out to `driver:event:<binding>` for every binding subscribed to the
 * emitting instance, so each app only receives its own stream.
 */

import type {
  DeviceCatalog,
  DeviceOption,
  DriverInfo,
  DriverInstanceInfo,
  DriverState,
} from '@gosai/shared';
import { ServerEvents } from '@gosai/shared/events';
import type { EventBus } from '../ipc/index.js';
import type { ChildLogger, Logger } from '../logger/index.js';
import { PythonBridge } from './bridge.js';

export interface DriverManifestEntry {
  readonly name: string;
  readonly events: readonly string[];
  readonly actions: readonly string[];
  readonly dependencies: readonly string[];
  readonly description?: string;
  readonly shared?: boolean;
}

export interface DriverManagerOptions {
  readonly pythonDir: string;
  readonly logger: Logger;
  readonly bus: EventBus;
  /**
   * Optional per-binding, per-driver startup config (e.g. an app's persisted
   * camera/microphone/speaker settings). Also used to resolve the device of a
   * shared device-bound instance.
   */
  readonly getDriverConfig?: (
    binding: string,
    driver: string,
  ) => Record<string, unknown> | undefined;
}

/** Default binding used when a request does not carry one (diagnostics). */
export const SYSTEM_BINDING = 'system';

interface InstanceRuntime {
  readonly instance: string;
  readonly driver: string;
  state: DriverState;
}

interface SubscriberRecord {
  readonly events: Set<string>;
  readonly binding: string;
}

const INSTANCE_KEY_SEP = '::';

export class DriverManager {
  private readonly log: ChildLogger;
  private readonly bridge: PythonBridge;
  /** Driver *types* keyed by name. */
  private readonly catalogue = new Map<string, DriverManifestEntry>();
  /** Running instances keyed by `${instance}::${driver}`. */
  private readonly instances = new Map<string, InstanceRuntime>();
  /** Subscribers keyed by instance key, then subscriber id. */
  private readonly subscribers = new Map<string, Map<string, SubscriberRecord>>();
  /** Memoised effective sharing policy per driver name. */
  private readonly sharedCache = new Map<string, boolean>();
  private starting: Promise<void> | null = null;

  constructor(private readonly options: DriverManagerOptions) {
    this.log = options.logger.child('drivers');
    this.bridge = new PythonBridge({
      pythonDir: options.pythonDir,
      logger: this.log,
      onEvent: (instance, driver, event, data, ts) =>
        this.handleDriverEvent(instance, driver, event, data, ts),
      onLog: (level, source, message) =>
        options.logger.log(`python:${source}`, normalizeLevel(level), message),
      onDriverState: (instance, driver, state) =>
        this.handleDriverState(instance, driver, state),
      onPerformance: (source, metric, value, ts) =>
        options.bus.emit(
          'server:performance',
          { source, type: 'driver', metric, value, timestamp: ts },
          'drivers',
        ),
      onExit: (code, signal) => {
        this.log.warn('python bridge exited', { code, signal });
        this.instances.clear();
        this.subscribers.clear();
        this.broadcastList();
      },
    });
  }

  async start(): Promise<void> {
    if (this.bridge.isRunning()) return;
    if (this.starting) {
      await this.starting;
      return;
    }
    this.starting = (async (): Promise<void> => {
      this.log.info('starting python bridge');
      await this.bridge.start();
      await this.refreshManifest();
    })();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  async stop(): Promise<void> {
    if (!this.bridge.isRunning()) return;
    await this.bridge.stop();
  }

  async refreshManifest(): Promise<void> {
    const result = await this.bridge.request<{ drivers: readonly DriverManifestEntry[] }>({
      type: 'list-drivers',
    });
    this.catalogue.clear();
    this.sharedCache.clear();
    for (const entry of result?.drivers ?? []) {
      this.catalogue.set(entry.name, entry);
    }
    this.broadcastList();
  }

  listDrivers(): DriverInfo[] {
    return Array.from(this.catalogue.values()).map((entry) => this.toDriverInfo(entry));
  }

  getDriver(name: string): DriverInfo | undefined {
    const entry = this.catalogue.get(name);
    if (!entry) return undefined;
    return this.toDriverInfo(entry);
  }

  /** Whether a driver instance for `binding` is currently running. */
  isInstanceRunning(binding: string, driver: string): boolean {
    const instance = this.instanceFor(binding, driver);
    return this.instances.get(this.instanceKey(instance, driver))?.state === 'running';
  }

  async startDriver(binding: string, name: string, requester: string): Promise<void> {
    const instance = this.instanceFor(binding, name);
    await this.startInstance(instance, name, requester, binding);
  }

  async stopDriver(binding: string, name: string, requester: string): Promise<void> {
    const instance = this.instanceFor(binding, name);
    await this.stopInstance(instance, name, requester, binding);
  }

  async subscribe(
    binding: string,
    driver: string,
    event: string,
    subscriber: string,
  ): Promise<void> {
    this.requireDriver(driver);
    const instance = this.instanceFor(binding, driver);
    const key = this.instanceKey(instance, driver);
    if (this.instances.get(key)?.state !== 'running') {
      await this.startInstance(instance, driver, subscriber, binding);
    }
    this.recordSubscriber(key, subscriber, event, binding);
    try {
      await this.bridge.request({ type: 'subscribe', instance, driver, event });
    } catch (err) {
      this.unrecordSubscriber(key, subscriber, event);
      throw err;
    }
    this.broadcastList();
  }

  async unsubscribe(
    binding: string,
    driver: string,
    event: string,
    subscriber: string,
  ): Promise<void> {
    if (!this.catalogue.has(driver)) return;
    const instance = this.instanceFor(binding, driver);
    await this.unsubscribeFromInstance(instance, driver, event, subscriber, binding);
  }

  /** Drop every subscription owned by `subscriber` so idle drivers can stop.
   * Errors on individual events are logged; the rest still run. */
  async unsubscribeAll(subscriber: string): Promise<void> {
    const targets: Array<{ instance: string; driver: string; binding: string; events: string[] }> =
      [];
    for (const [key, bySubscriber] of this.subscribers.entries()) {
      const record = bySubscriber.get(subscriber);
      if (!record) continue;
      const { instance, driver } = this.splitInstanceKey(key);
      targets.push({ instance, driver, binding: record.binding, events: Array.from(record.events) });
    }
    if (targets.length === 0) return;
    this.log.info('cleaning up driver subscriptions for disconnected client', {
      subscriber,
      drivers: targets.map((t) => t.driver),
    });
    for (const target of targets) {
      for (const event of target.events) {
        try {
          await this.unsubscribeFromInstance(
            target.instance,
            target.driver,
            event,
            subscriber,
            target.binding,
          );
        } catch (err) {
          this.log.warn('unsubscribeAll failed for one event', {
            driver: target.driver,
            event,
            subscriber,
            err: String(err),
          });
        }
      }
    }
  }

  async getData(binding: string, driver: string, event: string): Promise<unknown> {
    this.requireDriver(driver);
    const instance = this.instanceFor(binding, driver);
    return this.bridge.request({ type: 'get-data', instance, driver, event });
  }

  async execute(
    binding: string,
    driver: string,
    action: string,
    data: unknown,
  ): Promise<unknown> {
    this.requireDriver(driver);
    const instance = this.instanceFor(binding, driver);
    return this.bridge.request({ type: 'execute', instance, driver, action, data });
  }

  /** Enumerate connected cameras (instance-agnostic). */
  async listCameras(): Promise<DeviceOption[]> {
    const result = await this.bridge.request<{ devices?: RawDevice[] }>({ type: 'list-cameras' });
    return (result?.devices ?? []).map(toDeviceOption);
  }

  /** Enumerate audio input/output devices (instance-agnostic). */
  async listAudioDevices(): Promise<{ microphones: DeviceOption[]; speakers: DeviceOption[] }> {
    const result = await this.bridge.request<{
      microphones?: RawDevice[];
      speakers?: RawDevice[];
    }>({ type: 'list-audio-devices' });
    return {
      microphones: (result?.microphones ?? []).map(toDeviceOption),
      speakers: (result?.speakers ?? []).map(toDeviceOption),
    };
  }

  async listDevices(): Promise<DeviceCatalog> {
    const [cameras, audio] = await Promise.all([
      this.listCameras().catch(() => []),
      this.listAudioDevices().catch(() => ({ microphones: [], speakers: [] })),
    ]);
    return { cameras, microphones: audio.microphones, speakers: audio.speakers };
  }

  // ------------------------------------------------------------------
  // Instance lifecycle
  // ------------------------------------------------------------------

  private async startInstance(
    instance: string,
    driver: string,
    requester: string,
    binding: string,
  ): Promise<void> {
    const entry = this.requireDriver(driver);
    // Dependencies live in the same instance namespace so an exclusive driver
    // and its exclusive deps stay isolated together.
    for (const dep of entry.dependencies) {
      await this.startInstance(instance, dep, `${driver}:dep`, binding);
    }
    const key = this.instanceKey(instance, driver);
    this.setInstanceState(instance, driver, 'starting');
    this.broadcastList();
    try {
      const driverConfig = this.options.getDriverConfig?.(binding, driver);
      await this.bridge.request({
        type: 'start-driver',
        instance,
        driver,
        ...(driverConfig ? { config: driverConfig } : {}),
      });
      this.setInstanceState(instance, driver, 'running');
      this.recordSubscriber(key, requester, '*', binding);
      this.broadcastDriver(driver);
      this.broadcastList();
    } catch (err) {
      this.setInstanceState(instance, driver, 'errored');
      this.broadcastDriver(driver);
      this.broadcastList();
      throw err;
    }
  }

  private async stopInstance(
    instance: string,
    driver: string,
    requester: string,
    binding: string,
  ): Promise<void> {
    const entry = this.requireDriver(driver);
    const key = this.instanceKey(instance, driver);
    this.unrecordSubscriber(key, requester);
    if (this.hasAnySubscribers(key)) {
      this.broadcastList();
      return;
    }
    const runtime = this.instances.get(key);
    if (!runtime) {
      await this.releaseDependencies(instance, driver, binding, entry);
      return;
    }
    if (runtime.state !== 'running' && runtime.state !== 'starting') {
      this.setInstanceState(instance, driver, 'available');
      this.broadcastList();
      await this.releaseDependencies(instance, driver, binding, entry);
      return;
    }
    this.setInstanceState(instance, driver, 'stopping');
    this.broadcastList();
    try {
      await this.bridge.request({ type: 'stop-driver', instance, driver });
    } catch (err) {
      if (this.bridge.isRunning()) {
        this.log.error('failed to stop driver', { driver, instance, err: String(err) });
        throw err;
      }
      this.log.warn('driver stop skipped; bridge already exited', { driver, instance });
    }
    this.setInstanceState(instance, driver, 'available');
    this.broadcastDriver(driver);
    this.broadcastList();
    this.log.info('driver stopped', { driver, instance });
    await this.releaseDependencies(instance, driver, binding, entry);
  }

  private async releaseDependencies(
    instance: string,
    driver: string,
    binding: string,
    entry: DriverManifestEntry,
  ): Promise<void> {
    for (const dep of entry.dependencies) {
      try {
        await this.stopInstance(instance, dep, `${driver}:dep`, binding);
      } catch (err) {
        this.log.warn('failed to release dependency', {
          driver,
          dependency: dep,
          instance,
          err: String(err),
        });
      }
    }
  }

  private async unsubscribeFromInstance(
    instance: string,
    driver: string,
    event: string,
    subscriber: string,
    binding: string,
  ): Promise<void> {
    const key = this.instanceKey(instance, driver);
    this.unrecordSubscriber(key, subscriber, event);
    try {
      await this.bridge.request({ type: 'unsubscribe', instance, driver, event });
    } catch {
      // best-effort
    }
    if (!this.hasAnySubscribers(key)) {
      try {
        await this.stopInstance(instance, driver, subscriber, binding);
      } catch {
        // already handled
      }
    } else {
      this.broadcastList();
    }
  }

  // ------------------------------------------------------------------
  // Event routing
  // ------------------------------------------------------------------

  private handleDriverEvent(
    instance: string,
    driver: string,
    event: string,
    data: unknown,
    ts: number,
  ): void {
    const key = this.instanceKey(instance, driver);
    const bindings = this.bindingsSubscribedTo(key);
    for (const binding of bindings) {
      this.options.bus.emit(
        `${ServerEvents.DriverEvent}:${binding}`,
        { driver, event, data, ts, binding },
        `driver:${driver}`,
      );
    }
  }

  private handleDriverState(instance: string, driver: string, state: string): void {
    if (!this.catalogue.has(driver)) return;
    this.setInstanceState(instance, driver, normalizeDriverState(state));
    this.broadcastDriver(driver);
    this.broadcastList();
  }

  // ------------------------------------------------------------------
  // Sharing policy & instance keys
  // ------------------------------------------------------------------

  /** Resolve the instance namespace a driver runs in for a given binding. */
  private instanceFor(binding: string, driver: string): string {
    if (!this.isEffectivelyShared(driver)) return binding;
    const device = this.options.getDriverConfig?.(binding, driver)?.device;
    return typeof device === 'number' ? `shared:dev${device}` : 'shared';
  }

  /** A driver is effectively shared only if it and all its deps are shared. */
  private isEffectivelyShared(driver: string): boolean {
    const cached = this.sharedCache.get(driver);
    if (cached !== undefined) return cached;
    const result = this.computeShared(driver, new Set());
    this.sharedCache.set(driver, result);
    return result;
  }

  private computeShared(driver: string, seen: Set<string>): boolean {
    if (seen.has(driver)) return true;
    seen.add(driver);
    const entry = this.catalogue.get(driver);
    if (!entry || !entry.shared) return false;
    for (const dep of entry.dependencies) {
      if (!this.computeShared(dep, seen)) return false;
    }
    return true;
  }

  private instanceKey(instance: string, driver: string): string {
    return `${instance}${INSTANCE_KEY_SEP}${driver}`;
  }

  private splitInstanceKey(key: string): { instance: string; driver: string } {
    const idx = key.lastIndexOf(INSTANCE_KEY_SEP);
    return {
      instance: key.slice(0, idx),
      driver: key.slice(idx + INSTANCE_KEY_SEP.length),
    };
  }

  private setInstanceState(instance: string, driver: string, state: DriverState): void {
    const key = this.instanceKey(instance, driver);
    if (state === 'available' || state === 'stopped') {
      this.instances.delete(key);
      this.subscribers.delete(key);
      return;
    }
    const existing = this.instances.get(key);
    if (existing) {
      existing.state = state;
    } else {
      this.instances.set(key, { instance, driver, state });
    }
  }

  // ------------------------------------------------------------------
  // Broadcasts & projections
  // ------------------------------------------------------------------

  private toDriverInfo(entry: DriverManifestEntry): DriverInfo {
    const runtimes = this.instancesOf(entry.name);
    const instanceInfos: DriverInstanceInfo[] = runtimes.map((rt) => ({
      instance: rt.instance,
      state: rt.state,
      subscribers: this.flattenSubscribers(this.instanceKey(rt.instance, rt.driver)),
    }));
    const subscribers = Array.from(
      new Set(instanceInfos.flatMap((i) => i.subscribers)),
    );
    return {
      name: entry.name,
      ...(entry.description ? { description: entry.description } : {}),
      state: aggregateState(runtimes),
      events: entry.events,
      actions: entry.actions,
      dependencies: entry.dependencies,
      subscribers,
      shared: this.isEffectivelyShared(entry.name),
      ...(instanceInfos.length > 0 ? { instances: instanceInfos } : {}),
    };
  }

  private instancesOf(driver: string): InstanceRuntime[] {
    const out: InstanceRuntime[] = [];
    for (const runtime of this.instances.values()) {
      if (runtime.driver === driver) out.push(runtime);
    }
    return out;
  }

  private broadcastDriver(driver: string): void {
    const info = this.getDriver(driver);
    if (info) this.options.bus.emit(ServerEvents.DriverStateChanged, info, 'drivers');
  }

  private broadcastList(): void {
    this.options.bus.emit(
      ServerEvents.DriversListChanged,
      { drivers: this.listDrivers() },
      'drivers',
    );
  }

  private requireDriver(name: string): DriverManifestEntry {
    const entry = this.catalogue.get(name);
    if (!entry) {
      throw new Error(`Unknown driver: ${name}`);
    }
    return entry;
  }

  // ------------------------------------------------------------------
  // Subscriber bookkeeping
  // ------------------------------------------------------------------

  private recordSubscriber(
    key: string,
    subscriber: string,
    event: string,
    binding: string,
  ): void {
    let bySubscriber = this.subscribers.get(key);
    if (!bySubscriber) {
      bySubscriber = new Map();
      this.subscribers.set(key, bySubscriber);
    }
    const existing = bySubscriber.get(subscriber);
    if (existing) {
      existing.events.add(event);
    } else {
      bySubscriber.set(subscriber, { events: new Set([event]), binding });
    }
  }

  private unrecordSubscriber(key: string, subscriber: string, event?: string): void {
    const bySubscriber = this.subscribers.get(key);
    if (!bySubscriber) return;
    const record = bySubscriber.get(subscriber);
    if (!record) return;
    if (event === undefined) {
      bySubscriber.delete(subscriber);
    } else {
      record.events.delete(event);
      if (record.events.size === 0) bySubscriber.delete(subscriber);
    }
    if (bySubscriber.size === 0) this.subscribers.delete(key);
  }

  private hasAnySubscribers(key: string): boolean {
    const bySubscriber = this.subscribers.get(key);
    if (!bySubscriber) return false;
    for (const record of bySubscriber.values()) {
      if (record.events.size > 0) return true;
    }
    return false;
  }

  private flattenSubscribers(key: string): string[] {
    const bySubscriber = this.subscribers.get(key);
    if (!bySubscriber) return [];
    return Array.from(bySubscriber.keys());
  }

  private bindingsSubscribedTo(key: string): Set<string> {
    const bindings = new Set<string>();
    const bySubscriber = this.subscribers.get(key);
    if (!bySubscriber) return bindings;
    for (const record of bySubscriber.values()) {
      bindings.add(record.binding);
    }
    return bindings;
  }
}

interface RawDevice {
  index?: number;
  label?: string;
  name?: string;
  is_default?: boolean;
}

function toDeviceOption(raw: RawDevice): DeviceOption {
  return {
    index: typeof raw.index === 'number' ? raw.index : -1,
    label: raw.label ?? raw.name ?? `Device ${raw.index ?? '?'}`,
    ...(raw.is_default ? { isDefault: true } : {}),
  };
}

function aggregateState(runtimes: readonly InstanceRuntime[]): DriverState {
  if (runtimes.length === 0) return 'available';
  const states = new Set(runtimes.map((r) => r.state));
  if (states.has('running')) return 'running';
  if (states.has('starting')) return 'starting';
  if (states.has('stopping')) return 'stopping';
  if (states.has('paused')) return 'paused';
  if (states.has('errored')) return 'errored';
  return 'available';
}

function normalizeDriverState(raw: string): DriverState {
  switch (raw) {
    case 'available':
    case 'starting':
    case 'running':
    case 'paused':
    case 'stopped':
    case 'errored':
      return raw;
    default:
      return 'errored';
  }
}

function normalizeLevel(raw: string): 'debug' | 'info' | 'warn' | 'error' {
  switch (raw) {
    case 'debug':
    case 'info':
    case 'warn':
    case 'error':
      return raw;
    case 'warning':
      return 'warn';
    default:
      return 'info';
  }
}
