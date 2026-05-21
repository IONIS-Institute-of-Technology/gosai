/**
 * Driver manager. Talks to the Python bridge to start/stop drivers and route
 * driver events onto the in-process EventBus. Tracks driver state and
 * dependency relationships.
 */

import type { DriverInfo, DriverState } from '@gosai/shared';
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
}

export interface DriverManagerOptions {
  readonly pythonDir: string;
  readonly logger: Logger;
  readonly bus: EventBus;
}

export class DriverManager {
  private readonly log: ChildLogger;
  private readonly bridge: PythonBridge;
  private readonly drivers = new Map<string, DriverInfo>();
  private readonly subscribers = new Map<string, Map<string, Set<string>>>();
  private manifest: readonly DriverManifestEntry[] = [];
  private starting: Promise<void> | null = null;

  constructor(private readonly options: DriverManagerOptions) {
    this.log = options.logger.child('drivers');
    this.bridge = new PythonBridge({
      pythonDir: options.pythonDir,
      logger: this.log,
      onEvent: (driver, event, data, ts) => this.handleDriverEvent(driver, event, data, ts),
      onLog: (level, source, message) =>
        options.logger.log(`python:${source}`, normalizeLevel(level), message),
      onDriverState: (driver, state) => this.handleDriverState(driver, state),
      onPerformance: (source, metric, value, ts) =>
        options.bus.emit(
          'server:performance',
          { source, type: 'driver', metric, value, timestamp: ts },
          'drivers',
        ),
      onExit: (code, signal) => {
        this.log.warn('python bridge exited', { code, signal });
        for (const [name, info] of this.drivers.entries()) {
          this.drivers.set(name, { ...info, state: 'stopped' as DriverState });
        }
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
    this.manifest = result?.drivers ?? [];
    this.drivers.clear();
    for (const entry of this.manifest) {
      this.drivers.set(entry.name, {
        name: entry.name,
        ...(entry.description ? { description: entry.description } : {}),
        state: 'available',
        events: entry.events,
        actions: entry.actions,
        dependencies: entry.dependencies,
        subscribers: [],
      });
    }
    this.broadcastList();
  }

  listDrivers(): DriverInfo[] {
    return Array.from(this.drivers.values()).map((info) => ({
      ...info,
      subscribers: this.flattenSubscribers(info.name),
    }));
  }

  getDriver(name: string): DriverInfo | undefined {
    const info = this.drivers.get(name);
    if (!info) return undefined;
    return { ...info, subscribers: this.flattenSubscribers(name) };
  }

  async startDriver(name: string, requester: string): Promise<DriverInfo> {
    const info = this.requireDriver(name);
    for (const dep of info.dependencies) {
      await this.startDriver(dep, `${name}:dep`);
    }
    const next: DriverInfo = { ...info, state: 'starting' };
    this.drivers.set(name, next);
    this.broadcastList();
    try {
      await this.bridge.request({ type: 'start-driver', driver: name });
      const running: DriverInfo = {
        ...next,
        state: 'running',
        subscribers: this.flattenSubscribers(name),
      };
      this.drivers.set(name, running);
      this.recordSubscriber(name, requester, '*');
      this.broadcastState(running);
      this.broadcastList();
      return running;
    } catch (err) {
      const errored: DriverInfo = { ...next, state: 'errored' };
      this.drivers.set(name, errored);
      this.broadcastState(errored);
      this.broadcastList();
      throw err;
    }
  }

  async stopDriver(name: string, requester: string): Promise<DriverInfo> {
    const info = this.requireDriver(name);
    this.unrecordSubscriber(name, requester);
    if (this.hasAnySubscribers(name)) {
      const refreshed: DriverInfo = { ...info, subscribers: this.flattenSubscribers(name) };
      this.drivers.set(name, refreshed);
      this.broadcastList();
      return refreshed;
    }
    if (info.state !== 'running' && info.state !== 'starting') {
      this.broadcastList();
      await this.releaseDependencies(name, info);
      return info;
    }
    const next: DriverInfo = { ...info, state: 'stopping' };
    this.drivers.set(name, next);
    this.broadcastList();
    try {
      await this.bridge.request({ type: 'stop-driver', driver: name });
      const stopped: DriverInfo = {
        ...next,
        state: 'available',
        subscribers: [],
      };
      this.drivers.set(name, stopped);
      this.broadcastState(stopped);
      this.broadcastList();
      this.log.info('driver stopped', { driver: name });
      await this.releaseDependencies(name, info);
      return stopped;
    } catch (err) {
      if (!this.bridge.isRunning()) {
        const stopped: DriverInfo = {
          ...next,
          state: 'available',
          subscribers: [],
        };
        this.drivers.set(name, stopped);
        this.broadcastState(stopped);
        this.broadcastList();
        this.log.warn('driver stop skipped; bridge already exited', { driver: name });
        return stopped;
      }
      this.log.error('failed to stop driver', { driver: name, err: String(err) });
      throw err;
    }
  }

  private async releaseDependencies(name: string, info: DriverInfo): Promise<void> {
    for (const dep of info.dependencies) {
      try {
        await this.stopDriver(dep, `${name}:dep`);
      } catch (err) {
        this.log.warn('failed to release dependency', {
          driver: name,
          dependency: dep,
          err: String(err),
        });
      }
    }
  }

  async subscribe(driver: string, event: string, subscriber: string): Promise<void> {
    this.requireDriver(driver);
    const driverInfo = this.drivers.get(driver);
    if (driverInfo && driverInfo.state !== 'running') {
      await this.startDriver(driver, subscriber);
    }
    this.recordSubscriber(driver, subscriber, event);
    try {
      await this.bridge.request({ type: 'subscribe', driver, event });
    } catch (err) {
      this.unrecordSubscriber(driver, subscriber, event);
      throw err;
    }
    this.broadcastList();
  }

  async unsubscribe(driver: string, event: string, subscriber: string): Promise<void> {
    if (!this.drivers.has(driver)) return;
    this.unrecordSubscriber(driver, subscriber, event);
    try {
      await this.bridge.request({ type: 'unsubscribe', driver, event });
    } catch {
      // best-effort
    }
    if (!this.hasAnySubscribers(driver)) {
      try {
        await this.stopDriver(driver, subscriber);
      } catch {
        // already handled
      }
    } else {
      this.broadcastList();
    }
  }

  /** Drop every subscription owned by `subscriber` so idle drivers can stop.
   * Errors on individual events are logged; the rest still run. */
  async unsubscribeAll(subscriber: string): Promise<void> {
    const drivers = this.driversOwnedBy(subscriber);
    if (drivers.length === 0) return;
    this.log.info('cleaning up driver subscriptions for disconnected client', {
      subscriber,
      drivers,
    });
    for (const driver of drivers) {
      const events = this.eventsOwnedBy(driver, subscriber);
      for (const event of events) {
        try {
          await this.unsubscribe(driver, event, subscriber);
        } catch (err) {
          this.log.warn('unsubscribeAll failed for one event', {
            driver,
            event,
            subscriber,
            err: String(err),
          });
        }
      }
    }
  }

  private driversOwnedBy(subscriber: string): string[] {
    const out: string[] = [];
    for (const [driver, bySubscriber] of this.subscribers.entries()) {
      if (bySubscriber.has(subscriber)) out.push(driver);
    }
    return out;
  }

  private eventsOwnedBy(driver: string, subscriber: string): string[] {
    const bySubscriber = this.subscribers.get(driver);
    if (!bySubscriber) return [];
    const events = bySubscriber.get(subscriber);
    if (!events) return [];
    return Array.from(events);
  }

  async getData(driver: string, event: string): Promise<unknown> {
    this.requireDriver(driver);
    return this.bridge.request({ type: 'get-data', driver, event });
  }

  async execute(driver: string, action: string, data: unknown): Promise<unknown> {
    this.requireDriver(driver);
    return this.bridge.request({ type: 'execute', driver, action, data });
  }

  private handleDriverEvent(driver: string, event: string, data: unknown, ts: number): void {
    this.options.bus.emit(
      ServerEvents.DriverEvent,
      { driver, event, data, ts },
      `driver:${driver}`,
    );
  }

  private handleDriverState(driver: string, state: string): void {
    const current = this.drivers.get(driver);
    if (!current) return;
    const normalized = normalizeDriverState(state);
    const next: DriverInfo = {
      ...current,
      state: normalized,
      subscribers: this.flattenSubscribers(driver),
    };
    this.drivers.set(driver, next);
    this.broadcastState(next);
    this.broadcastList();
  }

  private broadcastState(info: DriverInfo): void {
    this.options.bus.emit(ServerEvents.DriverStateChanged, info, 'drivers');
  }

  private broadcastList(): void {
    this.options.bus.emit(
      ServerEvents.DriversListChanged,
      { drivers: this.listDrivers() },
      'drivers',
    );
  }

  private requireDriver(name: string): DriverInfo {
    const info = this.drivers.get(name);
    if (!info) {
      throw new Error(`Unknown driver: ${name}`);
    }
    return info;
  }

  private recordSubscriber(driver: string, subscriber: string, event: string): void {
    let bySubscriber = this.subscribers.get(driver);
    if (!bySubscriber) {
      bySubscriber = new Map();
      this.subscribers.set(driver, bySubscriber);
    }
    let events = bySubscriber.get(subscriber);
    if (!events) {
      events = new Set();
      bySubscriber.set(subscriber, events);
    }
    events.add(event);
  }

  private unrecordSubscriber(driver: string, subscriber: string, event?: string): void {
    const bySubscriber = this.subscribers.get(driver);
    if (!bySubscriber) return;
    const events = bySubscriber.get(subscriber);
    if (!events) return;
    if (event === undefined) {
      bySubscriber.delete(subscriber);
    } else {
      events.delete(event);
      if (events.size === 0) bySubscriber.delete(subscriber);
    }
    if (bySubscriber.size === 0) this.subscribers.delete(driver);
  }

  private hasAnySubscribers(driver: string): boolean {
    const bySubscriber = this.subscribers.get(driver);
    if (!bySubscriber) return false;
    for (const events of bySubscriber.values()) {
      if (events.size > 0) return true;
    }
    return false;
  }

  private flattenSubscribers(driver: string): string[] {
    const bySubscriber = this.subscribers.get(driver);
    if (!bySubscriber) return [];
    return Array.from(bySubscriber.keys());
  }
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
