/**
 * Driver manager. Decides which driver instances should run, keeps the Python
 * bridge in line with that decision, and routes driver events onto the
 * in-process EventBus.
 *
 * Bindings & instances
 * ---------------------
 * A *binding* is an app slug (or `system` for dashboard diagnostics). Each
 * driver has a sharing policy: exclusive drivers (camera, microphone, anything
 * that depends on them) get one instance per binding; shared drivers (speaker,
 * device-less utilities) get a single instance shared across bindings, keyed by
 * device when device-bound. The instance namespace is the binding for exclusive
 * drivers, or `shared` / `shared:dev<n>` for shared ones.
 *
 * Leases
 * ------
 * Every `subscribe` call adds a lease for one client, binding, driver and event,
 * remembering the instance it resolved to. A client that subscribes twice holds
 * two leases. Leases are the desired state; the bridge only reports what
 * actually runs. The reconciler compares the two and sends start, stop,
 * subscribe and unsubscribe requests until they match. Each instance has at
 * most one operation in flight, and operations on independent instances run
 * concurrently, so a slow model load only delays the leases that need it.
 * Dependencies start first and stop last, in the dependent's instance
 * namespace. When the bridge restarts, the reconciler applies every lease
 * again.
 *
 * Driver events fan out to `driver:event:<binding>` for every binding holding a
 * lease on that event, so each app only receives its own stream.
 */

import type {
  DeviceCatalog,
  DeviceOption,
  DriverInfo,
  DriverInstanceInfo,
  DriverRuntimeInfo,
  DriverSchema,
  DriverState,
} from '@gosai/shared';
import { ServerEvents } from '@gosai/shared/events';
import type { BridgeInstanceList } from '@gosai/shared/protocol';
import type { EventBus } from '../ipc/index.js';
import type { ChildLogger, Logger } from '../logger/index.js';
import {
  PythonBridge,
  type BridgeHandlers,
  type DriverBridge,
  type DriverBridgeFactory,
} from './bridge.js';
import { BridgeSupervisor, type SupervisorTiming } from './supervisor.js';

export interface DriverManifestEntry {
  readonly name: string;
  readonly events: readonly string[];
  readonly actions: readonly string[];
  readonly dependencies: readonly string[];
  readonly description?: string;
  readonly shared?: boolean;
  readonly schema?: DriverSchema | null;
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
  /** Builds the bridge. Defaults to the Python bridge in `pythonDir`. */
  readonly createBridge?: DriverBridgeFactory;
  readonly supervisorTiming?: Partial<SupervisorTiming>;
  /** How long `subscribe` waits for a starting or restarting bridge. */
  readonly bridgeReadyWaitMs?: number;
  /** Backoff between attempts to stop an instance whose stop timed out. */
  readonly stopRetry?: { readonly initialMs: number; readonly maxMs: number };
}

/** Default binding used when a request does not carry one (diagnostics). */
export const SYSTEM_BINDING = 'system';

// Starting may download or load a model; actions may run inference.
const START_TIMEOUT_MS = 5 * 60_000;
const EXECUTE_TIMEOUT_MS = 2 * 60_000;
// The bridge answers list-drivers once it has imported every driver module.
const CATALOGUE_TIMEOUT_MS = 2 * 60_000;
const DEFAULT_BRIDGE_READY_WAIT_MS = 60_000;
const DEFAULT_STOP_RETRY = { initialMs: 5_000, maxMs: 5 * 60_000 };

type Operation = 'start' | 'stop' | 'sync';

interface StopRetry {
  readonly at: number;
  readonly delayMs: number;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface ReadyWaiter {
  readonly resolve: () => void;
  readonly reject: (err: Error) => void;
}

interface Lease {
  readonly id: number;
  readonly client: string;
  readonly binding: string;
  readonly instance: string;
  readonly driver: string;
  readonly event: string;
}

interface InstanceRecord {
  readonly instance: string;
  readonly driver: string;
  state: DriverState;
  runtime?: DriverRuntimeInfo;
}

interface DesiredInstance {
  readonly instance: string;
  readonly driver: string;
  /** Binding whose config starts the instance. */
  readonly binding: string;
  /** Drivers in the same namespace that need this one. */
  readonly requiredBy: Set<string>;
}

interface Subscription {
  readonly instance: string;
  readonly driver: string;
  readonly event: string;
}

const KEY_SEP = '::';

function instanceKey(instance: string, driver: string): string {
  return `${instance}${KEY_SEP}${driver}`;
}

function subscriptionKey(sub: Subscription): string {
  return `${instanceKey(sub.instance, sub.driver)}${KEY_SEP}${sub.event}`;
}

export class DriverManager {
  private readonly log: ChildLogger;
  private readonly bridge: DriverBridge;
  private readonly supervisor: BridgeSupervisor;
  /** Driver *types* keyed by name. */
  private readonly catalogue = new Map<string, DriverManifestEntry>();
  /** Memoised effective sharing policy per driver name. */
  private readonly sharedCache = new Map<string, boolean>();
  private readonly leases = new Map<number, Lease>();
  private readonly leasesByInstance = new Map<string, Set<Lease>>();
  private nextLeaseId = 1;
  /** Instances the bridge reports, keyed by instance key. */
  private readonly actual = new Map<string, InstanceRecord>();
  /** Event subscriptions the bridge has acknowledged, keyed by subscription key. */
  private readonly bridgeSubscriptions = new Map<string, Subscription>();
  /** Last start failure per instance key. Only a new lease retries it. */
  private readonly startErrors = new Map<string, Error>();
  /** Subscription keys whose last subscribe or unsubscribe failed. Retried on the next lease change. */
  private readonly failedSubscriptions = new Set<string>();
  /** The one operation running per instance key. */
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly stopRetries = new Map<string, StopRetry>();
  private readonly readyWaiters = new Set<ReadyWaiter>();
  private bridgeReady = false;
  /** Between `start()` and `stop()`. */
  private active = false;
  /** Bumped whenever the bridge goes down, so late replies are ignored. */
  private generation = 0;

  constructor(private readonly options: DriverManagerOptions) {
    this.log = options.logger.child('drivers');
    const handlers: BridgeHandlers = {
      onEvent: (instance, driver, event, data, ts) =>
        this.handleDriverEvent(instance, driver, event, data, ts),
      onLog: (level, source, message, instance) =>
        options.logger.log(
          `python:${source}`,
          normalizeLevel(level),
          message,
          instance !== undefined ? { instance } : undefined,
        ),
      onDriverState: (instance, driver, state, runtime) =>
        this.handleDriverState(instance, driver, state, runtime),
      onPerformance: (sample) =>
        options.bus.emit(
          ServerEvents.PerformanceSample,
          {
            source: sample.source,
            instance: sample.instance,
            type: 'driver',
            metric: sample.metric,
            value: sample.value,
            timestamp: sample.ts,
          },
          'drivers',
        ),
      onExit: (code, signal) => this.supervisor.handleExit(code, signal),
    };
    const createBridge =
      options.createBridge ??
      ((bridgeHandlers: BridgeHandlers) =>
        new PythonBridge({
          pythonDir: options.pythonDir,
          logger: this.log,
          handlers: bridgeHandlers,
        }));
    this.bridge = createBridge(handlers);
    this.supervisor = new BridgeSupervisor({
      bridge: this.bridge,
      log: this.log,
      onReady: () => this.handleBridgeReady(),
      onDown: () => this.handleBridgeDown(),
      ...(options.supervisorTiming ? { timing: options.supervisorTiming } : {}),
    });
  }

  /** Start the bridge. If the first attempt fails, it keeps retrying in the background. */
  async start(): Promise<void> {
    this.log.info('starting python bridge');
    this.active = true;
    await this.supervisor.start();
  }

  async stop(): Promise<void> {
    this.active = false;
    this.rejectReadyWaiters(new Error('Python bridge is not running'));
    await this.supervisor.stop();
    this.handleBridgeDown();
  }

  async refreshManifest(): Promise<void> {
    const result = await this.bridge.request<{ drivers: readonly DriverManifestEntry[] }>(
      { type: 'list-drivers' },
      { timeoutMs: CATALOGUE_TIMEOUT_MS },
    );
    this.catalogue.clear();
    this.sharedCache.clear();
    for (const entry of result.drivers) {
      this.catalogue.set(entry.name, entry);
    }
    this.broadcastList();
  }

  listDrivers(): DriverInfo[] {
    const desired = this.desiredInstances();
    return Array.from(this.catalogue.values()).map((entry) => this.toDriverInfo(entry, desired));
  }

  getDriver(name: string): DriverInfo | undefined {
    const entry = this.catalogue.get(name);
    if (!entry) return undefined;
    return this.toDriverInfo(entry, this.desiredInstances());
  }

  /** Whether the driver instance `binding` uses is currently running. */
  isInstanceRunning(binding: string, driver: string): boolean {
    const key = instanceKey(this.resolveInstance(binding, driver), driver);
    return this.actual.get(key)?.state === 'running';
  }

  /** Bindings whose instance of `driver` is currently running. */
  runningBindings(driver: string): string[] {
    const bindings = new Set<string>();
    for (const lease of this.leases.values()) {
      if (this.isInstanceRunning(lease.binding, driver)) bindings.add(lease.binding);
    }
    return Array.from(bindings);
  }

  /**
   * Take a lease on `driver.event` for `client` and wait until the driver runs.
   * Waits for a bridge that is starting or restarting. Rejects, and drops the
   * lease, when the driver or a dependency fails to start.
   */
  async subscribe(binding: string, driver: string, event: string, client: string): Promise<void> {
    const deadline = Date.now() + (this.options.bridgeReadyWaitMs ?? DEFAULT_BRIDGE_READY_WAIT_MS);
    await this.waitForBridge(deadline);
    this.requireDriver(driver);
    const instance = this.instanceFor(binding, driver);
    const lease = this.addLease({ client, binding, instance, driver, event });
    const keys = this.closure(driver).map((name) => instanceKey(instance, name));
    // A new lease is an explicit request, so earlier failures get another try.
    for (const key of keys) this.startErrors.delete(key);
    this.failedSubscriptions.delete(subscriptionKey(lease));
    for (;;) {
      await this.settle(keys);
      if (this.bridgeReady) break;
      // The bridge went down while the driver was starting; wait for the restart.
      try {
        await this.waitForBridge(deadline);
      } catch (err) {
        this.removeLease(lease);
        throw err;
      }
    }
    const failure = this.leaseFailure(lease);
    if (failure) {
      this.removeLease(lease);
      await this.settle(keys);
      throw failure;
    }
  }

  /** Release one lease matching the arguments. */
  async unsubscribe(binding: string, driver: string, event: string, client: string): Promise<void> {
    let match: Lease | undefined;
    for (const lease of this.leases.values()) {
      if (
        lease.client === client &&
        lease.binding === binding &&
        lease.driver === driver &&
        lease.event === event
      ) {
        match = lease;
      }
    }
    if (!match) return;
    await this.release([match]);
  }

  /** Release every lease `client` holds so idle drivers can stop. */
  async unsubscribeAll(client: string): Promise<void> {
    const owned = Array.from(this.leases.values()).filter((lease) => lease.client === client);
    if (owned.length === 0) return;
    this.log.info('cleaning up driver subscriptions for disconnected client', {
      subscriber: client,
      drivers: owned.map((lease) => lease.driver),
    });
    await this.release(owned);
  }

  private async release(leases: readonly Lease[]): Promise<void> {
    const keys = new Set<string>();
    for (const lease of leases) {
      this.removeLease(lease);
      this.failedSubscriptions.delete(subscriptionKey(lease));
      for (const name of this.closure(lease.driver)) keys.add(instanceKey(lease.instance, name));
    }
    await this.settle(Array.from(keys));
  }

  async getData(binding: string, driver: string, event: string): Promise<unknown> {
    this.requireDriver(driver);
    const instance = this.resolveInstance(binding, driver);
    return this.bridge.request({ type: 'get-data', instance, driver, event });
  }

  async execute(binding: string, driver: string, action: string, data: unknown): Promise<unknown> {
    this.requireDriver(driver);
    const instance = this.resolveInstance(binding, driver);
    return this.bridge.request(
      { type: 'execute', instance, driver, action, data },
      { timeoutMs: EXECUTE_TIMEOUT_MS },
    );
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
      this.listCameras().catch((err: unknown) => {
        this.log.warn('camera enumeration failed', { err: String(err) });
        return [];
      }),
      this.listAudioDevices().catch((err: unknown) => {
        this.log.warn('audio device enumeration failed', { err: String(err) });
        return { microphones: [], speakers: [] };
      }),
    ]);
    return { cameras, microphones: audio.microphones, speakers: audio.speakers };
  }

  private addLease(fields: Omit<Lease, 'id'>): Lease {
    const lease: Lease = { id: this.nextLeaseId++, ...fields };
    this.leases.set(lease.id, lease);
    const key = instanceKey(lease.instance, lease.driver);
    let byInstance = this.leasesByInstance.get(key);
    if (!byInstance) {
      byInstance = new Set();
      this.leasesByInstance.set(key, byInstance);
    }
    byInstance.add(lease);
    return lease;
  }

  private removeLease(lease: Lease): void {
    if (!this.leases.delete(lease.id)) return;
    const key = instanceKey(lease.instance, lease.driver);
    const byInstance = this.leasesByInstance.get(key);
    byInstance?.delete(lease);
    if (byInstance?.size === 0) this.leasesByInstance.delete(key);
  }

  private waitForBridge(deadline: number): Promise<void> {
    if (this.bridgeReady) return Promise.resolve();
    if (!this.active) return Promise.reject(new Error('Python bridge is not running'));
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.readyWaiters.delete(waiter);
          reject(new Error('Python bridge did not become ready in time'));
        },
        Math.max(deadline - Date.now(), 0),
      );
      const waiter: ReadyWaiter = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      };
      this.readyWaiters.add(waiter);
    });
  }

  private rejectReadyWaiters(err: Error): void {
    for (const waiter of this.readyWaiters) waiter.reject(err);
    this.readyWaiters.clear();
  }

  private leaseFailure(lease: Lease): Error | null {
    if (!this.leases.has(lease.id)) return null;
    if (!this.bridgeReady) return new Error('Python bridge is not running');
    for (const name of this.closure(lease.driver)) {
      const key = instanceKey(lease.instance, name);
      const error = this.startErrors.get(key);
      if (error) return error;
      const state = this.actual.get(key)?.state ?? 'not running';
      if (state !== 'running') return new Error(`driver ${name} in ${lease.instance} is ${state}`);
    }
    if (!this.bridgeSubscriptions.has(subscriptionKey(lease))) {
      return new Error(`subscribing to ${lease.driver}.${lease.event} failed`);
    }
    return null;
  }

  private async handleBridgeReady(): Promise<void> {
    await this.refreshManifest();
    const listed = await this.bridge.request<BridgeInstanceList>({ type: 'list-instances' });
    this.actual.clear();
    this.bridgeSubscriptions.clear();
    for (const item of listed.instances) {
      this.actual.set(instanceKey(item.instance, item.driver), {
        instance: item.instance,
        driver: item.driver,
        state: normalizeDriverState(item.state),
      });
      for (const event of item.subscriptions) {
        const sub = { instance: item.instance, driver: item.driver, event };
        this.bridgeSubscriptions.set(subscriptionKey(sub), sub);
      }
    }
    this.bridgeReady = true;
    if (this.leases.size > 0) {
      this.log.info('re-applying driver leases', { leases: this.leases.size });
    }
    for (const waiter of this.readyWaiters) waiter.resolve();
    this.readyWaiters.clear();
    this.kick();
  }

  private handleBridgeDown(): void {
    this.generation += 1;
    this.bridgeReady = false;
    this.actual.clear();
    this.bridgeSubscriptions.clear();
    this.startErrors.clear();
    this.failedSubscriptions.clear();
    for (const retry of this.stopRetries.values()) clearTimeout(retry.timer);
    this.stopRetries.clear();
    this.broadcastList();
  }

  /** Start an operation for every instance that needs one and has none running. */
  private kick(): void {
    if (!this.bridgeReady) return;
    const desired = this.desiredInstances();
    for (const key of this.startErrors.keys()) {
      if (!desired.has(key)) this.startErrors.delete(key);
    }
    const keys = new Set([...desired.keys(), ...this.actual.keys()]);
    for (const sub of this.bridgeSubscriptions.values())
      keys.add(instanceKey(sub.instance, sub.driver));
    for (const key of keys) {
      if (this.inFlight.has(key)) continue;
      const operation = this.planFor(key, desired);
      if (!operation) continue;
      const done = this.runOperation(key, operation, desired.get(key))
        .catch((err: unknown) => {
          this.log.error('driver operation failed', { key, operation, err: String(err) });
        })
        .finally(() => {
          this.inFlight.delete(key);
          this.broadcastList();
          this.kick();
        });
      this.inFlight.set(key, done);
    }
  }

  /** Kick, then wait until no operation is running on `keys`. */
  private async settle(keys: readonly string[]): Promise<void> {
    for (;;) {
      this.kick();
      const pending = keys.flatMap((key) => {
        const op = this.inFlight.get(key);
        return op ? [op] : [];
      });
      if (pending.length === 0) return;
      await Promise.race(pending);
    }
  }

  private planFor(key: string, desired: ReadonlyMap<string, DesiredInstance>): Operation | null {
    const want = desired.get(key);
    const record = this.actual.get(key);
    if (record && (!want || record.state === 'errored')) {
      // Starting and stopping resolve on their own; the bridge reports the result.
      if (record.state === 'starting' || record.state === 'stopping') return null;
      if (this.hasPresentDependents(record)) return null;
      const retry = this.stopRetries.get(key);
      if (retry && retry.at > Date.now()) return null;
      return 'stop';
    }
    if (want && !record) {
      if (this.startErrors.has(key)) return null;
      const entry = this.catalogue.get(want.driver);
      if (!entry) return null;
      const depsRunning = entry.dependencies.every(
        (dep) => this.actual.get(instanceKey(want.instance, dep))?.state === 'running',
      );
      return depsRunning ? 'start' : null;
    }
    if (record?.state === 'running' && this.subscriptionChanges(key).length > 0) return 'sync';
    return null;
  }

  private async runOperation(
    key: string,
    operation: Operation,
    want: DesiredInstance | undefined,
  ): Promise<void> {
    const generation = this.generation;
    if (operation === 'start' && want) {
      await this.startInstance(want, generation);
    } else if (operation === 'stop') {
      const record = this.actual.get(key);
      if (record) await this.stopInstance(record, generation);
    } else if (operation === 'sync') {
      await this.syncSubscriptions(key, generation);
    }
  }

  private hasPresentDependents(record: InstanceRecord): boolean {
    for (const other of this.actual.values()) {
      if (other.instance !== record.instance) continue;
      if (this.catalogue.get(other.driver)?.dependencies.includes(record.driver)) return true;
    }
    return false;
  }

  /** Subscriptions to add (`true`) or remove (`false`) for one instance. */
  private subscriptionChanges(key: string): Array<[Subscription, boolean]> {
    const changes: Array<[Subscription, boolean]> = [];
    const wanted = new Map<string, Subscription>();
    for (const lease of this.leasesByInstance.get(key) ?? []) {
      wanted.set(subscriptionKey(lease), pickSubscription(lease));
    }
    for (const [subKey, sub] of wanted) {
      if (!this.bridgeSubscriptions.has(subKey) && !this.failedSubscriptions.has(subKey)) {
        changes.push([sub, true]);
      }
    }
    for (const [subKey, sub] of this.bridgeSubscriptions) {
      if (instanceKey(sub.instance, sub.driver) !== key || wanted.has(subKey)) continue;
      if (!this.failedSubscriptions.has(subKey)) changes.push([sub, false]);
    }
    return changes;
  }

  private async syncSubscriptions(key: string, generation: number): Promise<void> {
    for (const [sub, add] of this.subscriptionChanges(key)) {
      const subKey = subscriptionKey(sub);
      try {
        await this.bridge.request({ type: add ? 'subscribe' : 'unsubscribe', ...sub });
        if (generation !== this.generation) return;
        if (add) this.bridgeSubscriptions.set(subKey, sub);
        else this.bridgeSubscriptions.delete(subKey);
      } catch (err) {
        if (generation !== this.generation) return;
        this.failedSubscriptions.add(subKey);
        this.log.warn(`driver ${add ? 'subscribe' : 'unsubscribe'} failed`, {
          ...sub,
          err: String(err),
        });
      }
    }
  }

  private async startInstance(want: DesiredInstance, generation: number): Promise<void> {
    const { instance, driver } = want;
    const key = instanceKey(instance, driver);
    this.setActualState(instance, driver, 'starting');
    this.broadcastDriver(driver);
    try {
      const config = this.options.getDriverConfig?.(want.binding, driver);
      await this.bridge.request(
        { type: 'start-driver', instance, driver, ...(config ? { config } : {}) },
        { timeoutMs: START_TIMEOUT_MS },
      );
      if (generation !== this.generation) return;
      this.setActualState(instance, driver, 'running');
      this.log.info('driver started', { driver, instance });
    } catch (err) {
      if (generation !== this.generation) return;
      this.dropActual(key);
      const message = err instanceof Error ? err.message : String(err);
      this.startErrors.set(key, new Error(`driver ${driver} failed to start: ${message}`));
      this.log.warn('driver failed to start', { driver, instance, err: message });
    }
    this.broadcastDriver(driver);
  }

  private async stopInstance(record: InstanceRecord, generation: number): Promise<void> {
    const { instance, driver } = record;
    const key = instanceKey(instance, driver);
    this.setActualState(instance, driver, 'stopping');
    this.broadcastDriver(driver);
    try {
      await this.bridge.request({ type: 'stop-driver', instance, driver });
      if (generation !== this.generation) return;
      this.dropActual(key);
      const retry = this.stopRetries.get(key);
      if (retry) clearTimeout(retry.timer);
      this.stopRetries.delete(key);
      this.log.info('driver stopped', { driver, instance });
    } catch (err) {
      if (generation !== this.generation) return;
      const current = this.actual.get(key);
      if (current?.state === 'stopping') current.state = 'errored';
      const policy = this.options.stopRetry ?? DEFAULT_STOP_RETRY;
      const previous = this.stopRetries.get(key);
      const delayMs = previous ? Math.min(previous.delayMs * 2, policy.maxMs) : policy.initialMs;
      if (previous) clearTimeout(previous.timer);
      this.stopRetries.set(key, {
        at: Date.now() + delayMs,
        delayMs,
        timer: setTimeout(() => this.kick(), delayMs),
      });
      this.log.warn('driver did not stop; retrying later', {
        driver,
        instance,
        retryInMs: delayMs,
        err: String(err),
      });
    }
    this.broadcastDriver(driver);
  }

  /** Every instance the leases need, dependencies before dependents. */
  private desiredInstances(): Map<string, DesiredInstance> {
    const desired = new Map<string, DesiredInstance>();
    const visit = (
      instance: string,
      driver: string,
      binding: string,
      requiredBy: string | null,
      path: Set<string>,
    ): void => {
      const entry = this.catalogue.get(driver);
      const key = instanceKey(instance, driver);
      if (!entry || path.has(key)) return;
      path.add(key);
      for (const dep of entry.dependencies) visit(instance, dep, binding, driver, path);
      path.delete(key);
      let item = desired.get(key);
      if (!item) {
        item = { instance, driver, binding, requiredBy: new Set() };
        desired.set(key, item);
      }
      if (requiredBy !== null) item.requiredBy.add(requiredBy);
    };
    for (const lease of this.leases.values()) {
      visit(lease.instance, lease.driver, lease.binding, null, new Set());
    }
    return desired;
  }

  /** `driver` and its transitive dependencies, dependencies first. */
  private closure(driver: string): string[] {
    const names: string[] = [];
    const visiting = new Set<string>();
    const visit = (name: string): void => {
      if (names.includes(name) || visiting.has(name)) return;
      visiting.add(name);
      for (const dep of this.catalogue.get(name)?.dependencies ?? []) visit(dep);
      names.push(name);
    };
    visit(driver);
    return names;
  }

  private handleDriverEvent(
    instance: string,
    driver: string,
    event: string,
    data: unknown,
    ts: number,
  ): void {
    const leases = this.leasesByInstance.get(instanceKey(instance, driver));
    if (!leases) return;
    const bindings = new Set<string>();
    for (const lease of leases) {
      if (lease.event === event || lease.event === '*') bindings.add(lease.binding);
    }
    for (const binding of bindings) {
      this.options.bus.emit(
        `${ServerEvents.DriverEvent}:${binding}`,
        { driver, event, data, ts, binding },
        `driver:${driver}`,
      );
    }
  }

  private handleDriverState(
    instance: string,
    driver: string,
    state: string,
    runtime?: DriverRuntimeInfo,
  ): void {
    if (!this.catalogue.has(driver)) return;
    const key = instanceKey(instance, driver);
    const normalized = normalizeDriverState(state);
    if (normalized === 'available' || normalized === 'stopped') {
      this.dropActual(key);
    } else {
      this.setActualState(instance, driver, normalized, runtime);
    }
    this.broadcastDriver(driver);
    this.broadcastList();
    // Something started that nobody wants any more, e.g. after a start timed out.
    if (normalized === 'running' && !this.desiredInstances().has(key)) this.kick();
  }

  private setActualState(
    instance: string,
    driver: string,
    state: DriverState,
    runtime?: DriverRuntimeInfo,
  ): void {
    const key = instanceKey(instance, driver);
    const existing = this.actual.get(key);
    if (existing) {
      existing.state = state;
      if (runtime !== undefined) existing.runtime = runtime;
      return;
    }
    this.actual.set(key, {
      instance,
      driver,
      state,
      ...(runtime !== undefined ? { runtime } : {}),
    });
  }

  private dropActual(key: string): void {
    this.actual.delete(key);
    for (const [subKey, sub] of this.bridgeSubscriptions) {
      if (instanceKey(sub.instance, sub.driver) === key) this.bridgeSubscriptions.delete(subKey);
    }
  }

  /** Resolve the instance namespace a new lease for `binding` uses. */
  private instanceFor(binding: string, driver: string): string {
    if (!this.isEffectivelyShared(driver)) return binding;
    const device = this.options.getDriverConfig?.(binding, driver)?.device;
    return typeof device === 'number' ? `shared:dev${device}` : 'shared';
  }

  /**
   * The instance `binding` currently uses for `driver`: the one its newest
   * lease on the driver (or on a dependent) resolved to, so a device change
   * does not redirect requests away from a running instance.
   */
  private resolveInstance(binding: string, driver: string): string {
    const leases = Array.from(this.leases.values()).reverse();
    for (const lease of leases) {
      if (lease.binding !== binding) continue;
      if (this.closure(lease.driver).includes(driver)) return lease.instance;
    }
    return this.instanceFor(binding, driver);
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

  private toDriverInfo(
    entry: DriverManifestEntry,
    desired: ReadonlyMap<string, DesiredInstance>,
  ): DriverInfo {
    const records = new Map<string, InstanceRecord>();
    for (const [key, record] of this.actual) {
      if (record.driver === entry.name) records.set(key, record);
    }
    for (const [key, want] of desired) {
      if (want.driver === entry.name && !records.has(key) && this.startErrors.has(key)) {
        records.set(key, { instance: want.instance, driver: want.driver, state: 'errored' });
      }
    }
    const instanceInfos: DriverInstanceInfo[] = Array.from(records.entries()).map(
      ([key, record]) => ({
        instance: record.instance,
        state: record.state,
        subscribers: this.subscribersOf(key, desired.get(key)),
        ...(record.runtime ? { runtime: record.runtime } : {}),
      }),
    );
    const runtimes = Array.from(records.values());
    const subscribers = Array.from(new Set(instanceInfos.flatMap((i) => i.subscribers)));
    const primaryRuntime = runtimes.find((rt) => rt.runtime)?.runtime;
    return {
      name: entry.name,
      ...(entry.description ? { description: entry.description } : {}),
      state: aggregateState(runtimes),
      events: entry.events,
      actions: entry.actions,
      dependencies: entry.dependencies,
      subscribers,
      shared: this.isEffectivelyShared(entry.name),
      ...(primaryRuntime ? { runtime: primaryRuntime } : {}),
      ...(instanceInfos.length > 0 ? { instances: instanceInfos } : {}),
      ...(entry.schema ? { schema: entry.schema } : {}),
    };
  }

  private subscribersOf(key: string, desired: DesiredInstance | undefined): string[] {
    const clients = new Set<string>();
    for (const lease of this.leasesByInstance.get(key) ?? []) clients.add(lease.client);
    for (const dependent of desired?.requiredBy ?? []) clients.add(`${dependent}:dep`);
    return Array.from(clients);
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
}

function pickSubscription(sub: Subscription): Subscription {
  return { instance: sub.instance, driver: sub.driver, event: sub.event };
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

function aggregateState(runtimes: readonly InstanceRecord[]): DriverState {
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
    case 'stopping':
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
