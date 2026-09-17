/**
 * The sign vocabulary and a tracker that counts how long a sign is held.
 *
 * The `slr` driver emits a guess every time its 30-frame window moves. The
 * tracker spots a new guess by the feed's `lastUpdate` timestamp and counts
 * consecutive identical guesses, so holds are measured in recognizer outputs
 * whatever the display refresh rate.
 */

import type { MirrorFeed } from './feed.js';

/** The `slr` action set, in model output order. */
export const SIGN_ACTIONS = [
  'nothing',
  'empty',
  'ok',
  'yes',
  'no',
  'left',
  'right',
  'house',
  'store',
  'hello',
  'goodbye',
  'television',
  'leave',
  'eat',
  'apple',
  'peach',
] as const;

/** Guesses that mean no sign is being made. */
const NO_SIGN: ReadonlySet<string> = new Set(['nothing', 'empty']);

/** Signs a user can perform, i.e. {@link SIGN_ACTIONS} without the sentinels. */
export const PERFORMABLE_SIGNS: readonly string[] = SIGN_ACTIONS.filter((s) => !NO_SIGN.has(s));

/** Consecutive identical guesses after the first one that make a hold. */
export const SIGN_COUNT_THRESHOLD = 5;

export class SignTracker {
  private lastUpdate = 0;
  count = 0;
  sign = '';
  probability = 0;

  /** Consumes a new guess from the feed. Returns false when there was none. */
  update(feed: Pick<MirrorFeed, 'sign'>): boolean {
    if (feed.sign.lastUpdate === this.lastUpdate) return false;
    this.lastUpdate = feed.sign.lastUpdate;
    const guessed = feed.sign.data.guessed_sign;
    this.count = guessed === this.sign ? this.count + 1 : 0;
    this.sign = guessed;
    this.probability = feed.sign.data.probability;
    return true;
  }

  /** True when the current sign, or `sign` if given, is held past the threshold. */
  held(sign?: string): boolean {
    if (sign !== undefined && this.sign !== sign) return false;
    return this.count >= SIGN_COUNT_THRESHOLD;
  }

  /** True when the current guess is an actual sign. */
  performing(): boolean {
    return this.sign !== '' && !NO_SIGN.has(this.sign);
  }

  reset(): void {
    this.sign = '';
    this.count = 0;
    this.probability = 0;
  }
}
