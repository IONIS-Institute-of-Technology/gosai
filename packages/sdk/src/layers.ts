/**
 * Runs a set of layers inside one experience: independent modules that start,
 * render in z-order and stop, with rules about which layers may run together.
 * A compositor with a menu, overlays and launchable scenes is the typical use.
 */

/** A layer instance. Every hook is optional. */
export interface Layer<TFrame = unknown> {
  /** Loads assets. Runs once, before the first `start`. */
  preload?(): Promise<void>;
  /** Called when the layer starts. The layer renders once this resolves. */
  start?(): void | Promise<void>;
  /** Called every frame while the layer runs and the manager isn't suspended. */
  render?(frame: TFrame): void;
  /** Called when the layer stops. Release listeners and resources here. */
  stop?(): void | Promise<void>;
  /** Called while running when the manager suspends, e.g. to hide DOM or mute audio. */
  suspend?(): void;
  /** Called while running when the manager resumes. */
  resume?(): void;
}

export interface LayerDefinition<TFrame = unknown> {
  readonly slug: string;
  /** Higher values render on top. Layers with equal values render in registration order. */
  readonly zIndex?: number;
  /** Starting this layer stops every running layer except persistent and `allowed` ones. */
  readonly exclusive?: boolean;
  /** Layers an exclusive layer keeps running. */
  readonly allowed?: readonly string[];
  /** Layers started together with this one. */
  readonly required?: readonly string[];
  /**
   * Persistent layers survive exclusive starts and ignore `stop()` unless it
   * is forced. `stopAll()` still stops them.
   */
  readonly persistent?: boolean;
  /** Builds the instance. Called once, the first time the layer starts. */
  create(): Layer<TFrame>;
}

export type LayerPhase = 'preload' | 'start' | 'render' | 'stop' | 'suspend' | 'resume';

export interface LayerManagerOptions {
  /** Receives lifecycle errors. Render errors are reported once per activation. */
  readonly onError?: (slug: string, error: unknown, phase: LayerPhase) => void;
  /** Consecutive render failures after which a layer is stopped. Defaults to 30. */
  readonly maxRenderFailures?: number;
}

interface Entry<TFrame, TDef extends LayerDefinition<TFrame>> {
  readonly def: TDef;
  readonly order: number;
  instance: Layer<TFrame> | null;
  preloaded: boolean;
  running: boolean;
  ready: boolean;
  /** Incremented on every start and stop, so a stale activation can tell it lost. */
  activation: number;
  /** Settles once the latest start or stop hook has finished. */
  settled: Promise<void>;
  renderFailures: number;
  renderErrorReported: boolean;
}

const DEFAULT_MAX_RENDER_FAILURES = 30;

export class LayerManager<
  TFrame = unknown,
  TDef extends LayerDefinition<TFrame> = LayerDefinition<TFrame>,
> {
  private readonly entries = new Map<string, Entry<TFrame, TDef>>();
  private readonly onError: (slug: string, error: unknown, phase: LayerPhase) => void;
  private readonly maxRenderFailures: number;
  private suspended = false;

  constructor(definitions: readonly TDef[], options: LayerManagerOptions = {}) {
    this.onError = options.onError ?? ((): void => undefined);
    this.maxRenderFailures = options.maxRenderFailures ?? DEFAULT_MAX_RENDER_FAILURES;
    for (const def of definitions) {
      if (this.entries.has(def.slug)) throw new Error(`duplicate layer slug "${def.slug}"`);
      this.entries.set(def.slug, {
        def,
        order: this.entries.size,
        instance: null,
        preloaded: false,
        running: false,
        ready: false,
        activation: 0,
        settled: Promise.resolve(),
        renderFailures: 0,
        renderErrorReported: false,
      });
    }
  }

  /** Every definition, in registration order. */
  definitions(): TDef[] {
    return [...this.entries.values()].map((entry) => entry.def);
  }

  definition(slug: string): TDef | undefined {
    return this.entries.get(slug)?.def;
  }

  /** True from `start()` until `stop()`, including while the start hook runs. */
  isRunning(slug: string): boolean {
    return this.entries.get(slug)?.running ?? false;
  }

  /** True once the layer's start hook has finished and it renders. */
  isReady(slug: string): boolean {
    return this.entries.get(slug)?.ready ?? false;
  }

  /** Slugs of running layers, in registration order. */
  running(): string[] {
    return [...this.entries.values()].filter((e) => e.running).map((e) => e.def.slug);
  }

  isSuspended(): boolean {
    return this.suspended;
  }

  /**
   * Starts a layer. Exclusive layers first stop the layers they don't allow,
   * then start their required layers. Returns a promise that settles when the
   * start hook has run; errors go to `onError` and never reject.
   */
  start(slug: string): Promise<void> {
    const entry = this.entries.get(slug);
    if (!entry) return Promise.resolve();

    if (entry.def.exclusive) {
      const keep = new Set([slug, ...(entry.def.allowed ?? []), ...(entry.def.required ?? [])]);
      for (const other of this.entries.values()) {
        if (other.running && !other.def.persistent && !keep.has(other.def.slug)) {
          void this.stopEntry(other);
        }
      }
    }
    for (const required of entry.def.required ?? []) {
      if (required !== slug && !this.isRunning(required)) void this.start(required);
    }

    if (entry.running) return entry.settled;
    entry.running = true;
    entry.ready = false;
    const activation = ++entry.activation;
    entry.settled = this.activate(entry, activation, entry.settled);
    return entry.settled;
  }

  /**
   * Stops a layer. Persistent layers ignore this unless `force` is set. A
   * layer stopped while its start hook runs is stopped as soon as that hook
   * returns, and never renders.
   */
  stop(slug: string, options: { force?: boolean } = {}): Promise<void> {
    const entry = this.entries.get(slug);
    if (!entry || !entry.running) return Promise.resolve();
    if (entry.def.persistent && !options.force) return Promise.resolve();
    return this.stopEntry(entry);
  }

  toggle(slug: string): Promise<void> {
    return this.isRunning(slug) ? this.stop(slug) : this.start(slug);
  }

  /** Stops every running layer, persistent ones included, from the top down. */
  async stopAll(): Promise<void> {
    const running = [...this.entries.values()]
      .filter((entry) => entry.running)
      .sort((a, b) => compareZ(b, a));
    await Promise.all(running.map((entry) => this.stopEntry(entry)));
  }

  /** Stops rendering every layer and calls `suspend` on the running ones. */
  suspend(): void {
    if (this.suspended) return;
    this.suspended = true;
    for (const entry of this.entries.values()) {
      if (entry.ready) this.callHook(entry, 'suspend');
    }
  }

  /** Resumes rendering and calls `resume` on the running layers. */
  resume(): void {
    if (!this.suspended) return;
    this.suspended = false;
    for (const entry of this.entries.values()) {
      if (entry.ready) this.callHook(entry, 'resume');
    }
  }

  /** Renders every ready layer in ascending z-order. Does nothing while suspended. */
  render(frame: TFrame): void {
    if (this.suspended) return;
    const ready = [...this.entries.values()].filter((e) => e.ready).sort(compareZ);
    for (const entry of ready) {
      // An earlier layer's render may have stopped this one.
      if (!entry.ready || !entry.instance?.render) continue;
      try {
        entry.instance.render(frame);
        entry.renderFailures = 0;
      } catch (err) {
        entry.renderFailures += 1;
        if (!entry.renderErrorReported) {
          entry.renderErrorReported = true;
          this.onError(entry.def.slug, err, 'render');
        }
        if (entry.renderFailures >= this.maxRenderFailures) void this.stopEntry(entry);
      }
    }
  }

  private stopEntry(entry: Entry<TFrame, TDef>): Promise<void> {
    if (!entry.running) return entry.settled;
    const wasReady = entry.ready;
    entry.running = false;
    entry.ready = false;
    entry.activation += 1;
    // Stopping during start: the activation sees the new token and stops the
    // layer itself once the start hook returns.
    if (!wasReady) return entry.settled;
    entry.settled = entry.settled.then(() => this.runStop(entry));
    return entry.settled;
  }

  private async activate(
    entry: Entry<TFrame, TDef>,
    activation: number,
    previous: Promise<void>,
  ): Promise<void> {
    // Let a stop hook still running from the previous activation finish first.
    await previous;
    const current = (): boolean => entry.activation === activation;
    if (!current()) return;

    let phase: LayerPhase = 'start';
    try {
      entry.instance ??= entry.def.create();
      if (!entry.preloaded && entry.instance.preload) {
        phase = 'preload';
        await entry.instance.preload();
        entry.preloaded = true;
        phase = 'start';
        if (!current()) return;
      }
      await entry.instance.start?.();
    } catch (err) {
      this.onError(entry.def.slug, err, phase);
      if (current()) {
        entry.running = false;
        entry.activation += 1;
      }
      return;
    }

    if (!current()) {
      await this.runStop(entry);
      return;
    }
    entry.ready = true;
    entry.renderFailures = 0;
    entry.renderErrorReported = false;
    if (this.suspended) this.callHook(entry, 'suspend');
  }

  private async runStop(entry: Entry<TFrame, TDef>): Promise<void> {
    try {
      await entry.instance?.stop?.();
    } catch (err) {
      this.onError(entry.def.slug, err, 'stop');
    }
  }

  private callHook(entry: Entry<TFrame, TDef>, hook: 'suspend' | 'resume'): void {
    try {
      entry.instance?.[hook]?.();
    } catch (err) {
      this.onError(entry.def.slug, err, hook);
    }
  }
}

function compareZ(a: { def: { zIndex?: number }; order: number }, b: typeof a): number {
  return (a.def.zIndex ?? 0) - (b.def.zIndex ?? 0) || a.order - b.order;
}
