/**
 * Dependencies injected into every layer factory.
 *
 * Layers are created with this bundle so they can read the shared real-time
 * {@link MirrorFeed}, synthesize audio, launch/stop sibling layers and read
 * their options via the {@link MenuController}, resolve bundled assets, and
 * reach the runtime (logging, WebSocket round-trips, driver actions).
 */

import type { ExperienceRuntimeContext } from '@gosai/sdk';
import type { SecondSelfConfig } from './config.js';
import type { MirrorFeed } from './feed.js';
import type { MenuController } from './menu-controller.js';
import type { Synth } from './synth.js';

export interface LayerDeps {
  feed: MirrorFeed;
  synth: Synth;
  controller: MenuController;
  rt: ExperienceRuntimeContext;
  /** Loaded projection config (read-only for layers). */
  config: SecondSelfConfig;
  /** Resolve an asset path (relative to the app's `assets/` dir) to a URL. */
  assetUrl(path: string): string;
}
