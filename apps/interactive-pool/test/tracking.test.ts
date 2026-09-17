import { describe, expect, test } from 'bun:test';
import type { DriverTypes } from '@gosai/sdk';
import { DEFAULT_BALL_DIAMETER, parseBalls, parseFps, parseHands } from '../src/tracking.js';

/** A payload as it may arrive from the driver, whatever its declared type. */
function balls(entries: unknown): DriverTypes.ball.BallsPayload {
  return { balls: entries } as DriverTypes.ball.BallsPayload;
}

describe('parseBalls', () => {
  test('keeps the diameter and velocity the driver sends', () => {
    expect(parseBalls(balls([{ x: 10, y: 20, diameter: 42, vx: 3, vy: -4 }]))).toEqual([
      { x: 10, y: 20, diameter: 42, vx: 3, vy: -4 },
    ]);
  });

  test('fills a missing or invalid diameter and velocity with the defaults', () => {
    expect(
      parseBalls(
        balls([
          { x: 1, y: 2 },
          { x: 3, y: 4, diameter: 0, vx: 'fast', vy: null },
          { x: 5, y: 6, diameter: Number.NaN },
        ]),
      ),
    ).toEqual([
      { x: 1, y: 2, diameter: DEFAULT_BALL_DIAMETER, vx: 0, vy: 0 },
      { x: 3, y: 4, diameter: DEFAULT_BALL_DIAMETER, vx: 0, vy: 0 },
      { x: 5, y: 6, diameter: DEFAULT_BALL_DIAMETER, vx: 0, vy: 0 },
    ]);
  });

  test('drops entries without a finite position', () => {
    expect(
      parseBalls(balls([null, 7, { x: '1', y: 2 }, { x: Infinity, y: 0 }, { x: 0, y: 0 }])),
    ).toEqual([{ x: 0, y: 0, diameter: DEFAULT_BALL_DIAMETER, vx: 0, vy: 0 }]);
  });

  test('returns null for a payload without a ball list', () => {
    expect(parseBalls(null)).toBeNull();
    expect(parseBalls(balls(undefined))).toBeNull();
    expect(parseBalls(balls([]))).toEqual([]);
  });
});

describe('parseFps', () => {
  test('reads a finite, non-negative rate', () => {
    expect(parseFps({ fps: 29.5 })).toBe(29.5);
    expect(parseFps({ fps: -1 })).toBeNull();
    expect(parseFps({ fps: 'x' } as unknown as DriverTypes.ball.FpsPayload)).toBeNull();
    expect(parseFps(null)).toBeNull();
  });
});

describe('parseHands', () => {
  const payload = (hands: unknown) =>
    ({ hands_landmarks: hands }) as DriverTypes.hand_pose.HandPosePayload;

  test('keeps hands whose landmarks all have finite x and y', () => {
    const hand = [
      [0.1, 0.2, 0],
      [0.3, 0.4],
    ];
    expect(parseHands(payload([hand, [[0.1, null]], 'hand']))).toEqual([hand]);
    expect(parseHands(payload(undefined))).toEqual([]);
    expect(parseHands(null)).toEqual([]);
  });
});
