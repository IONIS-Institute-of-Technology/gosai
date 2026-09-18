import type {
  CalibrationProfile,
  CalibrationProfileInput,
  ExperienceRuntimeContext,
} from '@gosai/sdk';

export interface FakeRuntimeOptions {
  /** What the `pose_to_mirror` driver holds; actions merge their params into it. */
  readonly driver?: Record<string, unknown>;
  /** Launch params of the window. */
  readonly params?: Record<string, string>;
  /** `calibration:save` rejects. */
  readonly failSave?: boolean;
}

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

  constructor(options: FakeRuntimeOptions = {}) {
    const driver = options.driver ?? {};
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
      drivers: {
        execute: async (name: string, action: string, params?: unknown) => {
          this.executed.push({ driver: name, action, params });
          Object.assign(driver, params ?? {});
          return { ...driver };
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
      },
      log: {
        info: () => undefined,
        warn: (message: string) => void this.warnings.push(message),
        error: (message: string) => void this.warnings.push(message),
      },
    };
    this.rt = rt as unknown as ExperienceRuntimeContext;
  }
}
