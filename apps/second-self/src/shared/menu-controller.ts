/**
 * In-process layer manager + menu controller.
 *
 * Replaces the legacy socket-based `app_manager`. The compositor registers a
 * {@link LayerDef} per experience; the manager owns the running set, enforces
 * exclusivity/`allowed`/`required` relationships between layers, manages
 * per-layer options (toggles + buttons), and renders running layers in z-order.
 *
 * The menu layer talks to the manager through the {@link MenuController}
 * interface (a read/command subset) so it never imports concrete layers.
 */

import type { FrameContext, Layer } from './types.js';

export interface MenuOption {
  name: string;
  type: 'toggle' | 'button';
  /** Initial value for toggles. */
  default?: boolean;
}

export interface LayerDef {
  slug: string;
  label: string;
  /** SVG filename under assets/menu/icons (without path), if any. */
  icon?: string;
  /** Higher renders on top. */
  zIndex: number;
  /** Whether the layer appears in the launcher menu. */
  inMenu: boolean;
  /** When started, stop all running layers except `allowed` (+ menu + self). */
  exclusive?: boolean;
  /** Layers kept running when this exclusive layer starts. */
  allowed?: readonly string[];
  /** Layers force-started together with this one. */
  required?: readonly string[];
  options?: readonly MenuOption[];
  /** Construct the layer instance (called once, lazily). */
  create(): Layer;
}

/** Command/query subset exposed to the menu and option-aware layers. */
export interface MenuController {
  /** Menu-visible layer definitions, in registration order. */
  items(): LayerDef[];
  definition(slug: string): LayerDef | undefined;
  isRunning(slug: string): boolean;
  runningSlugs(): string[];
  start(slug: string): void;
  stop(slug: string): void;
  toggle(slug: string): void;
  options(slug: string): readonly MenuOption[];
  getOption(slug: string, name: string): boolean;
  setOption(slug: string, name: string, value: boolean): void;
  toggleOption(slug: string, name: string): void;
  /** Fire a button option. */
  triggerOption(slug: string, name: string): void;
  /** Listen for option/button changes (returns an unsubscribe fn). */
  onOption(slug: string, name: string, cb: (value: boolean) => void): () => void;
}

interface Entry {
  def: LayerDef;
  instance: Layer | null;
  running: boolean;
  ready: boolean;
  preloaded: boolean;
}

const ALWAYS_ON = 'menu';

export class LayerManager implements MenuController {
  private readonly entries = new Map<string, Entry>();
  private readonly order: string[] = [];
  private readonly optionState = new Map<string, boolean>();
  private readonly optionListeners = new Map<string, Set<(value: boolean) => void>>();
  private readonly onError: (slug: string, err: unknown) => void;

  constructor(defs: readonly LayerDef[], onError?: (slug: string, err: unknown) => void) {
    this.onError = onError ?? ((): void => undefined);
    for (const def of defs) {
      this.entries.set(def.slug, {
        def,
        instance: null,
        running: false,
        ready: false,
        preloaded: false,
      });
      this.order.push(def.slug);
      for (const opt of def.options ?? []) {
        this.optionState.set(
          optionKey(def.slug, opt.name),
          opt.type === 'toggle' ? !!opt.default : false,
        );
      }
    }
  }

  // -- MenuController queries -------------------------------------------------

  items(): LayerDef[] {
    return this.order.map((s) => this.entries.get(s)!.def).filter((d) => d.inMenu);
  }

  definition(slug: string): LayerDef | undefined {
    return this.entries.get(slug)?.def;
  }

  isRunning(slug: string): boolean {
    return this.entries.get(slug)?.running ?? false;
  }

  runningSlugs(): string[] {
    return this.order.filter((s) => this.entries.get(s)!.running);
  }

  // -- Lifecycle --------------------------------------------------------------

  /** Start a layer, applying exclusivity + required relationships. */
  start(slug: string): void {
    const entry = this.entries.get(slug);
    if (!entry) return;

    if (entry.def.exclusive) {
      const keep = new Set<string>([ALWAYS_ON, slug, ...(entry.def.allowed ?? [])]);
      for (const running of this.runningSlugs()) {
        if (!keep.has(running)) this.stop(running);
      }
      for (const req of entry.def.required ?? []) {
        if (!this.isRunning(req)) this.start(req);
      }
    }

    if (entry.running) return;
    entry.running = true;
    entry.ready = false;
    void this.activate(entry);
  }

  stop(slug: string): void {
    if (slug === ALWAYS_ON) return; // the launcher is always on.
    const entry = this.entries.get(slug);
    if (!entry || !entry.running) return;
    entry.running = false;
    entry.ready = false;
    try {
      entry.instance?.stop?.();
    } catch (err) {
      this.onError(slug, err);
    }
  }

  toggle(slug: string): void {
    if (this.isRunning(slug)) this.stop(slug);
    else this.start(slug);
  }

  /** Render every running, ready layer in ascending z-order. */
  render(frame: FrameContext): void {
    const running = this.runningSlugs()
      .map((s) => this.entries.get(s)!)
      .filter((e) => e.ready && e.instance)
      .sort((a, b) => a.def.zIndex - b.def.zIndex);
    for (const entry of running) {
      try {
        entry.instance!.render(frame);
      } catch (err) {
        this.onError(entry.def.slug, err);
      }
    }
  }

  /** Stop everything (compositor teardown). */
  stopAll(): void {
    for (const slug of [...this.runningSlugs()].reverse()) {
      const entry = this.entries.get(slug)!;
      entry.running = false;
      entry.ready = false;
      try {
        entry.instance?.stop?.();
      } catch (err) {
        this.onError(slug, err);
      }
    }
    // The launcher is excluded from runningSlugs()-driven stop above only via
    // start/stop; force-stop it here on teardown.
    const menu = this.entries.get(ALWAYS_ON);
    if (menu?.instance) {
      try {
        menu.instance.stop?.();
      } catch (err) {
        this.onError(ALWAYS_ON, err);
      }
    }
  }

  private async activate(entry: Entry): Promise<void> {
    try {
      if (!entry.instance) entry.instance = entry.def.create();
      if (!entry.preloaded && entry.instance.preload) {
        await entry.instance.preload();
        entry.preloaded = true;
      }
      await entry.instance.start?.();
      if (entry.running) entry.ready = true;
    } catch (err) {
      this.onError(entry.def.slug, err);
      entry.running = false;
      entry.ready = false;
    }
  }

  // -- Options ----------------------------------------------------------------

  options(slug: string): readonly MenuOption[] {
    return this.entries.get(slug)?.def.options ?? [];
  }

  getOption(slug: string, name: string): boolean {
    return this.optionState.get(optionKey(slug, name)) ?? false;
  }

  setOption(slug: string, name: string, value: boolean): void {
    const key = optionKey(slug, name);
    this.optionState.set(key, value);
    for (const cb of this.optionListeners.get(key) ?? []) {
      try {
        cb(value);
      } catch (err) {
        this.onError(slug, err);
      }
    }
  }

  toggleOption(slug: string, name: string): void {
    this.setOption(slug, name, !this.getOption(slug, name));
  }

  triggerOption(slug: string, name: string): void {
    const key = optionKey(slug, name);
    for (const cb of this.optionListeners.get(key) ?? []) {
      try {
        cb(true);
      } catch (err) {
        this.onError(slug, err);
      }
    }
  }

  onOption(slug: string, name: string, cb: (value: boolean) => void): () => void {
    const key = optionKey(slug, name);
    let set = this.optionListeners.get(key);
    if (!set) {
      set = new Set();
      this.optionListeners.set(key, set);
    }
    set.add(cb);
    return () => set!.delete(cb);
  }
}

function optionKey(slug: string, name: string): string {
  return `${slug}::${name}`;
}
