/**
 * Shared mutable snapshots driven by the compositor's driver subscriptions.
 * Layers read from the feed every frame; they never subscribe to drivers
 * directly.
 *
 * The feed is *intentionally mutable in place* so we avoid allocating new
 * arrays per frame. Layers must not mutate snapshot contents.
 */

import type { BallsSnapshot, HandsSnapshot } from './types.js';

export interface PoolFeed {
  readonly balls: BallsSnapshot;
  readonly hands: HandsSnapshot;
}

export function createPoolFeed(): PoolFeed {
  return {
    balls: { balls: [], fps: 0, lastUpdate: 0 },
    hands: { hands: [], handedness: [], lastUpdate: 0 },
  };
}
