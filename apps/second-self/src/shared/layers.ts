/**
 * The compositor's layer registry types and the launcher menu's per-layer
 * options. Layer lifecycle (exclusivity, required layers, activation races,
 * suspend) is the SDK's `LayerManager`; the menu options stay app-side.
 */

import type { LayerDefinition, LayerManager } from '@gosai/sdk';
import type { LayerGuide } from './guide.js';
import type { FrameContext } from './types.js';

export interface MenuOption {
  readonly name: string;
  readonly type: 'toggle' | 'button';
  /** Initial value for toggles. */
  readonly default?: boolean;
}

export interface LayerDef extends LayerDefinition<FrameContext> {
  readonly label: string;
  /** Whether the layer appears in the launcher menu. */
  readonly inMenu: boolean;
  /** Passive overlays that run at startup. The menu shows its hint while only these run. */
  readonly overlay?: boolean;
  /** What the layer tells the user when it starts. Layers without one stay silent. */
  readonly guide?: LayerGuide;
  readonly options?: readonly MenuOption[];
}

export type Layers = LayerManager<FrameContext, LayerDef>;

/** Toggle values and button listeners for the options layers expose in the menu. */
export class MenuOptions {
  private readonly values = new Map<string, boolean>();
  private readonly listeners = new Map<string, Set<() => void>>();

  constructor(
    definitions: readonly Pick<LayerDef, 'slug' | 'options'>[],
    private readonly onError: (slug: string, err: unknown) => void = () => undefined,
  ) {
    for (const def of definitions) {
      for (const option of def.options ?? []) {
        if (option.type === 'toggle') this.values.set(key(def.slug, option.name), !!option.default);
      }
    }
  }

  get(slug: string, name: string): boolean {
    return this.values.get(key(slug, name)) ?? false;
  }

  toggle(slug: string, name: string): void {
    this.values.set(key(slug, name), !this.get(slug, name));
  }

  /** Fires a button option. */
  trigger(slug: string, name: string): void {
    for (const listener of this.listeners.get(key(slug, name)) ?? []) {
      try {
        listener();
      } catch (err) {
        this.onError(slug, err);
      }
    }
  }

  /** Listens for a button option. Returns the unsubscribe function. */
  onTrigger(slug: string, name: string, listener: () => void): () => void {
    const k = key(slug, name);
    let set = this.listeners.get(k);
    if (!set) {
      set = new Set();
      this.listeners.set(k, set);
    }
    set.add(listener);
    return () => void set.delete(listener);
  }
}

function key(slug: string, name: string): string {
  return `${slug}::${name}`;
}
