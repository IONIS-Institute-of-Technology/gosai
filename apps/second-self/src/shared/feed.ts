/**
 * The latest driver payloads, shared by every layer.
 *
 * The compositor subscribes to each driver once and stores each payload as it
 * arrives, without copying it. Layers read the feed every frame and must never
 * mutate it.
 */

import type { FrequencyData, MirroredData, RawPoseData, SignData } from './types.js';

/** Camera frame size assumed until the `pose` driver reports the real one. */
export const DEFAULT_FRAME_WIDTH = 1280;
export const DEFAULT_FRAME_HEIGHT = 720;

export interface Snapshot<T> {
  data: T;
  /** `performance.now()` when `data` arrived; 0 before the first payload. */
  lastUpdate: number;
}

export interface MirrorFeed {
  readonly mirror: Snapshot<MirroredData>;
  readonly raw: Snapshot<RawPoseData>;
  readonly frequency: Snapshot<FrequencyData>;
  readonly sign: Snapshot<SignData>;
}

export function createMirrorFeed(): MirrorFeed {
  return {
    mirror: {
      data: {
        body_pose: [],
        right_hand_pose: [],
        left_hand_pose: [],
        face_mesh: [],
        body_world_pose: [],
        ts: 0,
      },
      lastUpdate: 0,
    },
    raw: {
      data: {
        body_pose: [],
        right_hand_pose: [],
        left_hand_pose: [],
        face_mesh: [],
        body_world_pose: [],
        frame_width: DEFAULT_FRAME_WIDTH,
        frame_height: DEFAULT_FRAME_HEIGHT,
        ts: 0,
        inference_ms: 0,
      },
      lastUpdate: 0,
    },
    frequency: {
      data: { max_frequency: 0, amplitude: 0, rfft: [], blocksize: 0, samplerate: 0 },
      lastUpdate: 0,
    },
    sign: {
      data: { guessed_sign: '', probability: 0 },
      lastUpdate: 0,
    },
  };
}
