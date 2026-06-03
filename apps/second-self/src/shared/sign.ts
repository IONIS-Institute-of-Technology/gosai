/**
 * Tracks the SLR feed and counts how long the current sign has been held.
 *
 * The `slr` driver emits a new guess each time its 30-frame window is full; we
 * detect a fresh emission via the feed's `lastUpdate` timestamp and increment a
 * stability counter while the guess stays the same (ported from the legacy
 * `count_valid` logic).
 */

import type { MirrorFeed } from './feed.js';

export const SIGN_COUNT_THRESHOLD = 5;

export class SignTracker {
  private lastUpdate = 0;
  private previous = '';
  count = 0;
  sign = '';
  probability = 0;

  /** Returns true when a new sign emission was consumed this call. */
  update(feed: MirrorFeed): boolean {
    if (feed.sign.lastUpdate === this.lastUpdate) return false;
    this.lastUpdate = feed.sign.lastUpdate;
    const guessed = feed.sign.data.guessed_sign;
    this.count = guessed === this.previous ? this.count + 1 : 0;
    this.previous = guessed;
    this.sign = guessed;
    this.probability = feed.sign.data.probability;
    return true;
  }

  /** True when the current sign has been held past the stability threshold. */
  held(sign?: string): boolean {
    if (sign !== undefined && this.sign !== sign) return false;
    return this.count >= SIGN_COUNT_THRESHOLD;
  }

  reset(): void {
    this.previous = '';
    this.sign = '';
    this.count = 0;
    this.probability = 0;
  }
}
