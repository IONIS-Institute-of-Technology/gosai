import { describe, expect, test } from 'bun:test';
import { fitNoseHip } from '../src/shared/align.js';
import type { MirrorFeed } from '../src/shared/feed.js';
import {
  PERFORMABLE_SIGNS,
  SIGN_ACTIONS,
  SIGN_COUNT_THRESHOLD,
  SignTracker,
} from '../src/shared/sign.js';
import { fitSample, meanDistance } from '../src/layers/sign-training.js';

function signFeed(): Pick<MirrorFeed, 'sign'> & { emit(sign: string, probability?: number): void } {
  let clock = 0;
  const feed = {
    sign: { data: { guessed_sign: '', probability: 0 }, lastUpdate: 0 },
    emit(sign: string, probability = 1): void {
      feed.sign.data = { guessed_sign: sign, probability };
      feed.sign.lastUpdate = ++clock;
    },
  };
  return feed;
}

describe('SignTracker', () => {
  test('counts recognizer outputs, not render frames', () => {
    const feed = signFeed();
    const tracker = new SignTracker();
    feed.emit('ok');
    expect(tracker.update(feed)).toBe(true);
    // Many render frames without a new guess don't advance the hold.
    for (let frame = 0; frame < 100; frame++) expect(tracker.update(feed)).toBe(false);
    expect(tracker.count).toBe(0);
    expect(tracker.held('ok')).toBe(false);

    for (let output = 0; output < SIGN_COUNT_THRESHOLD; output++) {
      feed.emit('ok');
      tracker.update(feed);
    }
    expect(tracker.held('ok')).toBe(true);
    expect(tracker.held('yes')).toBe(false);
  });

  test('a different guess restarts the hold', () => {
    const feed = signFeed();
    const tracker = new SignTracker();
    for (let output = 0; output <= SIGN_COUNT_THRESHOLD; output++) {
      feed.emit('ok');
      tracker.update(feed);
    }
    feed.emit('no');
    tracker.update(feed);
    expect(tracker.count).toBe(0);
    expect(tracker.held()).toBe(false);
  });

  test('reset does not replay the last guess', () => {
    const feed = signFeed();
    const tracker = new SignTracker();
    feed.emit('ok');
    tracker.update(feed);
    tracker.reset();
    expect(tracker.update(feed)).toBe(false);
    expect(tracker.sign).toBe('');
  });

  test('performable signs leave out the sentinels', () => {
    expect(PERFORMABLE_SIGNS).toEqual(SIGN_ACTIONS.slice(2));
    const tracker = new SignTracker();
    const feed = signFeed();
    feed.emit('nothing');
    tracker.update(feed);
    expect(tracker.performing()).toBe(false);
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
