/**
 * Shared mutable snapshots driven by the compositor's driver subscriptions.
 * Layers read from the feed every frame; they never subscribe to drivers
 * directly (except `sensor_server` in the ambient layer, which is optional
 * and lazy).
 *
 * The feed is *intentionally mutable in place* so we avoid allocating new
 * arrays per frame. Layers must not mutate snapshot contents.
 */

import type { BallsSnapshot, CueSnapshot, HandsSnapshot } from './types.js';

export interface PoolFeed {
  readonly balls: BallsSnapshot;
  readonly hands: HandsSnapshot;
  readonly cue: CueSnapshot;
}

export function createPoolFeed(): PoolFeed {
  return {
    balls: { balls: [], fps: 0, lastUpdate: 0 },
    hands: { hands: [], handedness: [], lastUpdate: 0 },
    cue: {
      cue: { detected: false, a: { x: 0, y: 0 }, b: { x: 0, y: 0 } },
      lastUpdate: 0,
    },
  };
}
