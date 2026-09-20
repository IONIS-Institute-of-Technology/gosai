import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fitNoseHip } from '../src/shared/align.js';
import {
  PERFORMABLE_SIGNS,
  SIGN_ACTIONS,
  SIGN_EVIDENCE_MS,
  SIGN_RELEASE_MS,
  SignTracker,
} from '../src/shared/sign.js';
import {
  closeness,
  fitSample,
  handInFrame,
  meanDistance,
  poseScale,
  signVideoPath,
} from '../src/layers/sign-training.js';

const FRAME_MS = 16;
/** A tracked hand: one valid landmark is all `handsTracked` looks at. */
const HAND = [[540, 900, 0, 1]];

/**
 * Drives a tracker the way the compositor does: render frames at a steady
 * rate, with the recogniser guessing on every one of them.
 */
function harness(): {
  tracker: SignTracker;
  /** Renders `ms` of frames. `sign` is what the recogniser reports each frame. */
  run(ms: number, sign: string, options?: { probability?: number; hands?: boolean }): void;
  /** Renders `ms` of frames with hands down and the recogniser reporting nothing. */
  rest(ms: number): void;
} {
  const feed = {
    sign: { data: { guessed_sign: '', probability: 0 }, lastUpdate: 0 },
    mirror: {
      data: { right_hand_pose: [] as number[][], left_hand_pose: [] as number[][] },
      lastUpdate: 0,
    },
  };
  const tracker = new SignTracker();
  let clock = 0;

  function step(sign: string, probability: number, hands: boolean): void {
    clock += FRAME_MS;
    feed.sign.data = { guessed_sign: sign, probability };
    feed.sign.lastUpdate = clock;
    feed.mirror.data = hands
      ? { right_hand_pose: HAND, left_hand_pose: [] }
      : { right_hand_pose: [], left_hand_pose: [] };
    feed.mirror.lastUpdate = clock;
    tracker.update(feed as never, FRAME_MS, clock);
  }

  return {
    tracker,
    run(ms, sign, options = {}): void {
      for (let t = 0; t < ms; t += FRAME_MS) {
        step(sign, options.probability ?? 1, options.hands ?? true);
      }
    },
    rest(ms): void {
      for (let t = 0; t < ms; t += FRAME_MS) step('nothing', 1, false);
    },
  };
}

/** Arms the tracker, then performs `sign` for `ms`. */
function perform(h: ReturnType<typeof harness>, sign: string, ms: number): void {
  h.rest(300);
  h.run(ms, sign);
}

describe('SignTracker', () => {
  test('a sign has to be performed, not glimpsed', () => {
    const h = harness();
    // The recogniser fires ~30 times a second: a fifth of a second of guesses
    // used to be enough to commit.
    perform(h, 'ok', 300);
    expect(h.tracker.held('ok')).toBe(false);
    expect(h.tracker.progressFor('ok')).toBeGreaterThan(0);

    h.run(SIGN_EVIDENCE_MS, 'ok');
    expect(h.tracker.held('ok')).toBe(true);
    expect(h.tracker.held('yes')).toBe(false);
  });

  test('a sign recognised most of the time still gets there', () => {
    const h = harness();
    h.rest(300);
    // Two frames recognised, one not, over and over: the real recogniser drops
    // out mid-sign and the old unbroken-hold rule could never finish.
    for (let i = 0; i < 400; i++) {
      h.run(FRAME_MS * 2, 'house');
      h.run(FRAME_MS, 'no');
    }
    expect(h.tracker.held('house')).toBe(true);
  });

  test('a sign recognised now and then never gets there', () => {
    const h = harness();
    h.rest(300);
    // One frame in five, which is what a sign nobody is making looks like.
    for (let i = 0; i < 400; i++) {
      h.run(FRAME_MS, 'house');
      h.run(FRAME_MS * 4, 'no');
    }
    expect(h.tracker.held('house')).toBe(false);
    expect(h.tracker.progressFor('house')).toBeLessThan(0.5);
  });

  test('evidence is per sign, so a stray guess costs little', () => {
    const h = harness();
    perform(h, 'ok', SIGN_EVIDENCE_MS * 0.9);
    const before = h.tracker.progressFor('ok');
    h.run(FRAME_MS * 3, 'yes');
    expect(h.tracker.progressFor('ok')).toBeGreaterThan(before - 0.05);
    expect(h.tracker.progressFor('yes')).toBeLessThan(0.1);
  });

  test('nothing counts while no hand is tracked', () => {
    const h = harness();
    h.rest(300);
    // The recogniser is confident, but it is classifying zero-padded input.
    h.run(SIGN_EVIDENCE_MS * 3, 'house', { hands: false });
    expect(h.tracker.held('house')).toBe(false);
  });

  test('nothing counts until hands have been at rest', () => {
    const h = harness();
    expect(h.tracker.armed()).toBe(false);
    // Hands already up and the recogniser stuck on a sign: it must not answer.
    h.run(SIGN_EVIDENCE_MS * 3, 'house');
    expect(h.tracker.armed()).toBe(false);
    expect(h.tracker.held('house')).toBe(false);

    h.rest(300);
    expect(h.tracker.armed()).toBe(true);
    h.run(SIGN_EVIDENCE_MS, 'house');
    expect(h.tracker.held('house')).toBe(true);
  });

  test('uncertain guesses never build evidence', () => {
    const h = harness();
    h.rest(300);
    h.run(SIGN_EVIDENCE_MS * 3, 'ok', { probability: 0.3 });
    expect(h.tracker.held('ok')).toBe(false);
  });

  test('evidence stops building when the recogniser stops', () => {
    const h = harness();
    h.rest(300);
    h.run(200, 'ok');
    // Frames keep coming but no new guess does: the feed goes stale.
    const before = h.tracker.progressFor('ok');
    for (let t = 0; t < SIGN_EVIDENCE_MS * 2; t += FRAME_MS) h.run(0, 'ok');
    expect(h.tracker.progressFor('ok')).toBeLessThanOrEqual(before);
    expect(h.tracker.held('ok')).toBe(false);
  });

  test('consume forgets everything and disarms', () => {
    const h = harness();
    perform(h, 'ok', SIGN_EVIDENCE_MS * 2);
    expect(h.tracker.held('ok')).toBe(true);

    h.tracker.consume();
    expect(h.tracker.held('ok')).toBe(false);
    expect(h.tracker.armed()).toBe(false);
    // Still holding the sign builds nothing until the hands come down.
    h.run(SIGN_EVIDENCE_MS * 2, 'ok');
    expect(h.tracker.held('ok')).toBe(false);

    perform(h, 'ok', SIGN_EVIDENCE_MS);
    expect(h.tracker.held('ok')).toBe(true);
  });

  test('the grace period outlasts the sign that was just acted on', () => {
    const h = harness();
    h.tracker.consume(SIGN_RELEASE_MS);
    h.rest(300);
    expect(h.tracker.armed()).toBe(true);
    h.run(FRAME_MS * 2, 'ok');
    expect(h.tracker.progressFor('ok')).toBe(0);
  });

  test('reset does not replay the last guess', () => {
    const h = harness();
    perform(h, 'ok', 200);
    h.tracker.reset();
    expect(h.tracker.sign).toBe('');
    expect(h.tracker.held()).toBe(false);
  });

  test('a guess nobody offered is noise, not an argument against', () => {
    const h = harness();
    h.tracker.setCandidates(['left', 'right']);
    h.rest(300);
    // The recogniser wanders onto "television" a third of the time. It is not
    // on offer here, so it must barely cost the sign being attempted.
    for (let i = 0; i < 400; i++) {
      h.run(FRAME_MS * 2, 'left');
      h.run(FRAME_MS, 'television');
    }
    expect(h.tracker.held('left')).toBe(true);
    expect(h.tracker.progressFor('television')).toBe(0);
  });

  test('a sign nobody offered can never be committed', () => {
    const h = harness();
    h.tracker.setCandidates(['left', 'right']);
    h.rest(300);
    h.run(SIGN_EVIDENCE_MS * 3, 'television');
    expect(h.tracker.held()).toBe(false);
    expect(h.tracker.held('television')).toBe(false);
  });

  test('two answers the recogniser cannot separate commit to neither', () => {
    const h = harness();
    h.tracker.setCandidates(['left', 'right']);
    h.rest(300);
    // An even split, which is what "left" and "right" look like to the model.
    for (let i = 0; i < 400; i++) {
      h.run(FRAME_MS, 'left');
      h.run(FRAME_MS, 'right');
    }
    expect(h.tracker.held()).toBe(false);
    expect(h.tracker.contested()).toBe(true);
  });

  test('a clear favourite wins even against a lookalike', () => {
    const h = harness();
    h.tracker.setCandidates(['left', 'right']);
    h.rest(300);
    for (let i = 0; i < 400; i++) {
      h.run(FRAME_MS * 3, 'left');
      h.run(FRAME_MS, 'right');
    }
    expect(h.tracker.held('left')).toBe(true);
    expect(h.tracker.contested()).toBe(false);
  });

  test('performable signs leave out the sentinels', () => {
    expect(PERFORMABLE_SIGNS).toEqual(SIGN_ACTIONS.slice(2));
  });
});

describe('nose-hip fit', () => {
  test('maps the reference nose and hip onto the user', () => {
    const fit = fitNoseHip([500, 400], [500, 800], [100, 100], [100, 300]);
    expect(fit).toEqual({ ratio: 2, offsetX: 300, offsetY: 200 });
  });

  test('refuses a zero ratio when nose and hip coincide', () => {
    expect(fitNoseHip([500, 400], [500, 400], [100, 100], [100, 300])).toBeNull();
    expect(fitNoseHip([500, 400], [500, 800], [100, 100], [100, 100])).toBeNull();
    expect(fitNoseHip([Number.NaN, 400], [500, 800], [100, 100], [100, 300])).toBeNull();
  });

  test('sign-training scores a fitted sample and never divides by zero', () => {
    const body = Array.from({ length: 33 }, () => [540, 900, 0, 1]);
    const sample = {
      body: Array.from({ length: 33 }, (): [number, number] => [100, 100]),
      right_hand: [],
      left_hand: [],
    };
    // Nose and hip in the same spot on both skeletons: no usable fit.
    expect(fitSample(body, sample)).toBeNull();

    body[24] = [540, 1300, 0, 1];
    sample.body[24] = [100, 300];
    const fit = fitSample(body, sample);
    expect(fit).not.toBeNull();
    const distance = meanDistance(fit!, sample.body, body, [0, 24]);
    expect(Number.isFinite(distance)).toBe(true);
    expect(distance).toBeCloseTo(0);
    expect(meanDistance(fit!, sample.body, [], [0, 24])).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('sign-training corrections', () => {
  const body = (nose: [number, number], hip: [number, number]): [number, number][] => {
    const points = Array.from({ length: 33 }, (): [number, number] => [0, 0]);
    points[0] = nose;
    points[24] = hip;
    return points;
  };

  test('a recorded hand that was never seen is all zeros', () => {
    expect(handInFrame([])).toBe(false);
    expect(handInFrame([[0, 0]])).toBe(false);
    expect(handInFrame([[277, 318]])).toBe(true);
  });

  test('the reference scale is its own nose-to-hip distance', () => {
    expect(poseScale({ body: body([100, 100], [100, 400]) })).toBe(300);
    expect(poseScale({ body: [] })).toBe(0);
  });

  test('a bar is full at the tolerance and empties as the user drifts out', () => {
    const part = { label: 'body', tolerance: 40, used: true, diff: 0 };
    expect(closeness(part)).toBe(1);
    expect(closeness({ ...part, diff: 40 })).toBe(1);
    expect(closeness({ ...part, diff: 60 })).toBeCloseTo(0.5);
    expect(closeness({ ...part, diff: 80 })).toBe(0);
    expect(closeness({ ...part, diff: 200 })).toBe(0);
  });

  test('a part the reference does not use never blocks and never empties', () => {
    const unused = {
      label: 'left hand',
      tolerance: 40,
      used: false,
      diff: Number.POSITIVE_INFINITY,
    };
    expect(closeness(unused)).toBe(1);
  });

  test('a part with nothing to compare reads as empty rather than as done', () => {
    const missing = { label: 'body', tolerance: 40, used: true, diff: Number.POSITIVE_INFINITY };
    expect(closeness(missing)).toBe(0);
  });
});

describe('sign-training videos', () => {
  test("every performable sign has Aria's clip", () => {
    const assets = join(import.meta.dir, '..', 'assets');
    const missing = PERFORMABLE_SIGNS.filter(
      (sign) => !existsSync(join(assets, signVideoPath(sign))),
    );
    expect(missing).toEqual([]);
  });
});
