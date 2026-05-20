/**
 * Compositor-side hook exposed to the menu layer.
 *
 * The compositor owns the list of menu-launchable layer slugs and the
 * "currently active layer" state. The menu reads from / writes to this
 * controller; it does not import individual layer modules.
 */

export interface MenuItem {
  /** Layer slug used by the compositor. */
  readonly slug: string;
  /** Human-readable name displayed inside the menu. */
  readonly label: string;
}

export interface MenuController {
  /** Layers the menu can launch, in display order. */
  readonly items: readonly MenuItem[];
  /** Currently active layer slug, or null. */
  active(): string | null;
  /** Activate a layer, or deactivate when slug is null. */
  setActive(slug: string | null): void;
}
