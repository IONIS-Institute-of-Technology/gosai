/**
 * What every layer factory receives: the shared real-time feed, the synth,
 * the layer manager and menu options, the mirror projection and the runtime
 * context (logging, assets, drivers).
 */

import type { ExperienceRuntimeContext, FullscreenCanvas } from '@gosai/sdk';
import type { MirrorFeed } from './feed.js';
import type { Layers, MenuOptions } from './layers.js';
import type { Projection } from './projection.js';
import type { Synth } from './synth.js';

export interface LayerDeps {
  readonly rt: ExperienceRuntimeContext;
  /** The compositor's canvas. Layers with their own canvas stack it in `surface.container`. */
  readonly surface: FullscreenCanvas;
  readonly feed: MirrorFeed;
  readonly synth: Synth;
  readonly layers: Layers;
  readonly options: MenuOptions;
  readonly projection: Projection;
  /**
   * Turns the face mesh on or off in the raw `pose` stream or the mirrored
   * stream. Layers that draw or solve it enable it while they run, so the
   * drivers don't send 478 unused points per frame.
   */
  setFaceMesh(stream: 'raw' | 'mirrored', enabled: boolean): void;
  /** URL of a file under the app's `assets/` directory. */
  asset(path: string): string;
  /**
   * Starts the overlay layers again unless an exclusive layer is running or
   * the experience is stopping.
   */
  restoreOverlays(): void;
}
