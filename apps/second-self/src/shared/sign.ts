/**
 * The sign vocabulary and the tracker that decides when a sign was meant.
 *
 * The `slr` driver runs its 30-frame window on every camera frame, so it emits
 * a guess about 30 times a second, and those guesses are noisy in both
 * directions: they drop out in the middle of a sign that is being performed
 * correctly, and they land confidently on a sign nobody is making when the
 * hand landmarks are poor. A rule of "the same guess, unbroken, for N
 * milliseconds" fails at both ends, so this keeps **evidence** instead:
 *
 * - Each sign has its own budget, in milliseconds. Time recognised as a sign
 *   adds to that sign's budget; time recognised as anything else drains every
 *   other budget, but slowly. A sign that flickers in and out still adds up,
 *   while one seen a quarter of the time never reaches the threshold.
 * - A layer says which signs it will act on. A guess that isn't one of them is
 *   noise and barely drains anything: the recogniser wandering onto
 *   "television" while someone signs "left" should cost them nothing. Only a
 *   rival answer, one the layer would also accept, argues against.
 * - The leader has to be clearly ahead of the runner-up. Some signs look alike
 *   to the recogniser, "left" and "right" among them, and picking whichever
 *   crossed the line first would be a coin toss in a game about learning which
 *   is which. Neck-and-neck answers commit to nothing, and {@link contested}
 *   lets the layer say so and offer another way through.
 * - Nothing counts while no hand is tracked. Without hands the recogniser is
 *   classifying zero-padded input, and it does so with confidence.
 * - Nothing counts until the tracker is **armed**, which takes a moment of
 *   hands at rest. Hands that happen to be up when a question appears can
 *   otherwise answer it, and a recogniser stuck on one sign then fails safe
 *   (nothing happens) instead of failing wrong (it picks for you).
 */

import type { MirrorFeed } from './feed.js';
import { isValid } from './mirror.js';

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

/** Evidence one sign needs before it is acted on. */
export const SIGN_EVIDENCE_MS = 1000;
/**
 * How fast a sign's evidence drains while a rival answer is recognised. Above
 * 0.5, so the answer seen most of the time climbs while the minority one sinks
 * instead of creeping up and blocking the margin.
 */
const RIVAL_FORGET_RATE = 0.55;
/** How fast it drains while the recogniser is on something nobody is offering. */
const NOISE_FORGET_RATE = 0.15;
/** How far ahead of the runner-up a sign must be before it is acted on. */
const MARGIN_MS = 350;
/**
 * Evidence may run a little past the threshold, so one stray guess as the
 * user finishes the sign doesn't take the commit back.
 */
const EVIDENCE_CEILING_MS = SIGN_EVIDENCE_MS * 1.2;
/** Guesses less certain than this are ignored. */
const MIN_PROBABILITY = 0.7;
/** Hands at rest for this long arm the tracker. */
const ARM_MS = 250;
/** No guess for this long means the recogniser stopped. */
const STALE_MS = 500;
/** How long input is ignored after a sign is acted on. */
export const SIGN_RELEASE_MS = 400;

/** True when the mirror feed is tracking at least one hand. */
function handsTracked(feed: Pick<MirrorFeed, 'mirror'>, now: number): boolean {
  if (now - feed.mirror.lastUpdate > STALE_MS) return false;
  const { right_hand_pose, left_hand_pose } = feed.mirror.data;
  return isValid(right_hand_pose[0]) || isValid(left_hand_pose[0]);
}

export class SignTracker {
  private lastUpdate = 0;
  /** Evidence per sign, in milliseconds. Absent means none. */
  private readonly evidence = new Map<string, number>();
  private graceMs = 0;
  private restMs = 0;
  /** The signs the layer will act on, or null while it will act on any. */
  private candidates: ReadonlySet<string> | null = null;
  /** Whether hands have been at rest since the last sign was acted on. */
  private ready = false;
  /** The recogniser's latest guess, for the on-screen readout. */
  sign = '';
  probability = 0;

  /**
   * Advances the evidence by one frame. Returns whether the recogniser
   * produced a new guess, which is what a layer wants for per-output work
   * such as building up a recognised sentence.
   */
  update(feed: Pick<MirrorFeed, 'sign' | 'mirror'>, deltaMs: number, now: number): boolean {
    const fresh = feed.sign.lastUpdate !== this.lastUpdate;
    if (fresh) {
      this.lastUpdate = feed.sign.lastUpdate;
      this.sign = feed.sign.data.guessed_sign;
      this.probability = feed.sign.data.probability;
    }
    this.graceMs = Math.max(0, this.graceMs - deltaMs);

    // Anything the recogniser isn't sure about counts as rest, so a stream of
    // weak guesses can't leave the tracker unable to arm.
    const live = now - feed.sign.lastUpdate < STALE_MS;
    const signing =
      live && handsTracked(feed, now) && this.performing() && this.probability >= MIN_PROBABILITY;
    if (signing) {
      this.restMs = 0;
    } else {
      this.restMs += deltaMs;
      if (this.restMs >= ARM_MS) this.ready = true;
    }

    const guess = signing && this.ready && this.graceMs === 0 ? this.sign : '';
    const counted = guess && (this.candidates?.has(guess) ?? true) ? guess : '';
    // Only a rival answer argues against the others; anything else is noise.
    const rate = counted ? RIVAL_FORGET_RATE : NOISE_FORGET_RATE;
    for (const [sign, ms] of this.evidence) {
      if (sign === counted) continue;
      const next = ms - deltaMs * rate;
      if (next > 0) this.evidence.set(sign, next);
      else this.evidence.delete(sign);
    }
    if (counted) {
      const next = (this.evidence.get(counted) ?? 0) + deltaMs;
      this.evidence.set(counted, Math.min(EVIDENCE_CEILING_MS, next));
    }
    return fresh;
  }

  /**
   * False until hands have been at rest, so a layer can say "lower your hands"
   * rather than leave the user holding a sign that is never going to count.
   */
  armed(): boolean {
    return this.ready;
  }

  /**
   * The signs this layer will act on. Everything else becomes noise: it no
   * longer drains the sign being attempted, and it can never be committed.
   * Pass null to accept any sign again.
   */
  setCandidates(signs: readonly string[] | null): void {
    this.candidates = signs ? new Set(signs) : null;
  }

  /** True when a sign, or `sign` if given, has won outright. */
  held(sign?: string): boolean {
    const winner = this.winner();
    if (winner === null) return false;
    return sign === undefined || winner === sign;
  }

  /**
   * True when two answers are close enough that neither can win: the
   * recogniser can't tell them apart, and the layer should offer another way.
   */
  contested(): boolean {
    const [best, second] = this.ranked();
    return best >= SIGN_EVIDENCE_MS / 2 && best - second < MARGIN_MS;
  }

  /** The sign with enough evidence and a clear lead, or null. */
  private winner(): string | null {
    const [best, second, sign] = this.ranked();
    if (best < SIGN_EVIDENCE_MS || best - second < MARGIN_MS) return null;
    return sign;
  }

  /** The best and runner-up evidence, and which sign leads. */
  private ranked(): [best: number, second: number, sign: string] {
    let best = 0;
    let second = 0;
    let leader = '';
    for (const [sign, ms] of this.evidence) {
      if (ms > best) {
        second = best;
        best = ms;
        leader = sign;
      } else if (ms > second) {
        second = ms;
      }
    }
    return [best, second, leader];
  }

  /** How much evidence `sign` has gathered, 0 to 1. Layers draw this. */
  progressFor(sign: string): number {
    return Math.min(1, (this.evidence.get(sign) ?? 0) / SIGN_EVIDENCE_MS);
  }

  /** True when the latest guess is an actual sign. */
  performing(): boolean {
    return this.sign !== '' && !NO_SIGN.has(this.sign);
  }

  /**
   * Forgets every sign and disarms. Call it after acting on a sign, so the one
   * still being made can't fire twice, and when a question appears, so hands
   * that are already up have to come back to rest before they answer it.
   */
  consume(ms = SIGN_RELEASE_MS): void {
    this.evidence.clear();
    this.graceMs = ms;
    this.restMs = 0;
    this.ready = false;
  }

  reset(): void {
    this.sign = '';
    this.probability = 0;
    this.consume(0);
  }
}
