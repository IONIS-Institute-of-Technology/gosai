/**
 * Shared, mutable real-time data snapshots.
 *
 * The compositor subscribes to drivers once and writes the latest payloads into
 * this feed in place (no per-frame allocations). Layers read from the feed every
 * frame and must never mutate its contents.
 */

import type { FrequencyData, MirroredData, RawPoseData, SignData } from './types.js';

export interface MirrorSnapshot {
  data: MirroredData;
  lastUpdate: number;
}

export interface RawPoseSnapshot {
  data: RawPoseData;
  lastUpdate: number;
}

export interface FrequencySnapshot {
  data: FrequencyData;
  lastUpdate: number;
}

export interface SignSnapshot {
  data: SignData;
  lastUpdate: number;
}

export interface MirrorFeed {
  readonly mirror: MirrorSnapshot;
  readonly raw: RawPoseSnapshot;
  readonly frequency: FrequencySnapshot;
  readonly sign: SignSnapshot;
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
        frame_width: 1280,
        frame_height: 720,
      },
      lastUpdate: 0,
    },
    frequency: {
      data: { max_frequency: 0, amplitude: 0, rfft: [] },
      lastUpdate: 0,
    },
    sign: {
      data: { guessed_sign: '', probability: 0 },
      lastUpdate: 0,
    },
  };
}
