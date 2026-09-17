/**
 * Reads the ball and hand_pose driver events into {@link Tracking}. The
 * payloads are typed from the driver schemas, but they cross a process
 * boundary, so each one is checked once here and layers can trust the result.
 */

import type { DriverTypes } from '@gosai/sdk';
import type { Ball, Hand, Tracking } from './shared/types.js';

/** Diameter used when the driver reports none, in reference-space pixels. */
export const DEFAULT_BALL_DIAMETER = 80;

export function createTracking(): Tracking {
  return { balls: [], ballsUpdatedAt: 0, ballFps: 0, hands: [] };
}

/**
 * The balls of a `ball.balls` payload, or `null` when it has no ball list.
 * Balls without a finite position are dropped; a missing or invalid diameter
 * becomes {@link DEFAULT_BALL_DIAMETER} and a missing velocity 0.
 */
export function parseBalls(payload: DriverTypes.ball.BallsPayload | null): Ball[] | null {
  const entries: unknown = payload?.balls;
  if (!Array.isArray(entries)) return null;
  const balls: Ball[] = [];
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { x, y, diameter, vx, vy } = entry as Partial<Record<keyof Ball, unknown>>;
    if (!isFiniteNumber(x) || !isFiniteNumber(y)) continue;
    balls.push({
      x,
      y,
      diameter: isFiniteNumber(diameter) && diameter > 0 ? diameter : DEFAULT_BALL_DIAMETER,
      vx: isFiniteNumber(vx) ? vx : 0,
      vy: isFiniteNumber(vy) ? vy : 0,
    });
  }
  return balls;
}

/** The rate of a `ball.fps` payload, or `null` when it has none. */
export function parseFps(payload: DriverTypes.ball.FpsPayload | null): number | null {
  const fps: unknown = payload?.fps;
  return isFiniteNumber(fps) && fps >= 0 ? fps : null;
}

/** The hands of a `hand_pose.raw_data` payload that have finite x and y for every landmark. */
export function parseHands(payload: DriverTypes.hand_pose.HandPosePayload | null): Hand[] {
  const entries: unknown = payload?.hands_landmarks;
  if (!Array.isArray(entries)) return [];
  return entries.filter(
    (hand): hand is Hand =>
      Array.isArray(hand) &&
      hand.every(
        (landmark: unknown) =>
          Array.isArray(landmark) && isFiniteNumber(landmark[0]) && isFiniteNumber(landmark[1]),
      ),
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
