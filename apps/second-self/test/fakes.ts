import type {
  CalibrationProfile,
  CalibrationProfileInput,
  ExperienceRuntimeContext,
} from '@gosai/sdk';

/**
 * What one driver action answers. Throwing rejects the action, which is how
 * the drivers report a refusal (`code: explanation`).
 */
export type DriverResponder = (params: unknown) => unknown;

export interface FakeRuntimeOptions {
  /** What the `pose_to_mirror` driver holds; actions merge their params into it. */
  readonly driver?: Record<string, unknown>;
  /** Answers for single actions, keyed `driver.action`. Others merge as above. */
  readonly responses?: Readonly<Record<string, DriverResponder>>;
  /** Launch params of the window. */
  readonly params?: Record<string, string>;
  /** `calibration:save` rejects. */
  readonly failSave?: boolean;
}

type Listener = (data: unknown) => void;

/** A runtime context that records what the app asks of the server. */
export class FakeRuntime {
  readonly executed: Array<{ driver: string; action: string; params: unknown }> = [];
  readonly storage = new Map<string, unknown>();
  readonly settings: Array<Record<string, unknown>> = [];
  /** The app's calibration profile on the server. */
  profile: CalibrationProfile | null = null;
  readonly switched: string[] = [];
  readonly emitted: Array<{ topic: string; data: unknown }> = [];
  readonly warnings: string[] = [];
  readonly rt: ExperienceRuntimeContext;
  private readonly driverListeners = new Map<string, Listener[]>();
  private readonly topicListeners = new Map<string, Listener[]>();

  constructor(options: FakeRuntimeOptions = {}) {
    const driver = options.driver ?? {};
    const responses = options.responses ?? {};
    const request = async (type: string, payload: { profile?: CalibrationProfileInput }) => {
      if (type === 'calibration:get') {
        return { profile: this.profile, calibrated: this.profile !== null };
      }
      if (type === 'calibration:save') {
        if (options.failSave) throw new Error('offline');
        this.profile = { version: 1, savedAt: 1, ...payload.profile! };
        return { profile: this.profile };
      }
      throw new Error(`unexpected ${type}`);
    };
    const rt = {
      app: { appSlug: 'second-self', params: options.params ?? {}, server: { request } },
      assets: { url: (path: string) => `https://gosai.test/static/${path}` },
      signal: new AbortController().signal,
      drivers: {
        execute: async (name: string, action: string, params?: unknown) => {
          this.executed.push({ driver: name, action, params });
          const responder = responses[`${name}.${action}`];
          if (responder) return responder(params);
          Object.assign(driver, params ?? {});
          return { ...driver };
        },
        on: (name: string, event: string, listener: Listener) => {
          const key = `${name}.${event}`;
          const listeners = this.driverListeners.get(key) ?? [];
          listeners.push(listener);
          this.driverListeners.set(key, listeners);
          return {
            ready: Promise.resolve(),
            unsubscribe: () =>
              this.driverListeners.set(
                key,
                (this.driverListeners.get(key) ?? []).filter((entry) => entry !== listener),
              ),
          };
        },
      },
      storage: {
        get: async (key: string) => this.storage.get(key),
        set: async (key: string, value: unknown) => void this.storage.set(key, value),
        remove: async (key: string) => void this.storage.delete(key),
      },
      settings: { set: async (values: Record<string, unknown>) => void this.settings.push(values) },
      router: { switchTo: async (slug: string) => void this.switched.push(slug) },
      events: {
        emit: async (topic: string, data: unknown) => void this.emitted.push({ topic, data }),
        on: (topic: string, listener: Listener) => {
          const listeners = this.topicListeners.get(topic) ?? [];
          listeners.push(listener);
          this.topicListeners.set(topic, listeners);
          return {
            unsubscribe: () =>
              this.topicListeners.set(
                topic,
                (this.topicListeners.get(topic) ?? []).filter((entry) => entry !== listener),
              ),
          };
        },
      },
      log: {
        info: () => undefined,
        warn: (message: string) => void this.warnings.push(message),
        error: (message: string) => void this.warnings.push(message),
      },
    };
    this.rt = rt as unknown as ExperienceRuntimeContext;
  }

  /** Delivers a driver event to whoever subscribed to it. */
  emitDriver(driver: string, event: string, data: unknown): void {
    for (const listener of this.driverListeners.get(`${driver}.${event}`) ?? []) listener(data);
  }

  /** Delivers an app event, as the other window's `rt.events.emit` would. */
  emitApp(topic: string, data: unknown): void {
    for (const listener of this.topicListeners.get(topic) ?? []) listener(data);
  }

  /** How many listeners a driver event still has. */
  subscribed(driver: string, event: string): number {
    return (this.driverListeners.get(`${driver}.${event}`) ?? []).length;
  }

  /** How many listeners an app topic still has. */
  listening(topic: string): number {
    return (this.topicListeners.get(topic) ?? []).length;
  }

  /** Every call to one action, in order. */
  callsTo(driver: string, action: string): unknown[] {
    return this.executed
      .filter((call) => call.driver === driver && call.action === action)
      .map((call) => call.params);
  }
}
