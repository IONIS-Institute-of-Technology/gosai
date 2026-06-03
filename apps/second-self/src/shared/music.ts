/**
 * Musical helpers shared by the theremine and music-training layers.
 *
 * Ports the note/frequency/duration math from the legacy theremine.js and
 * music_training.js, and bundles the musical element table + scores (the same
 * JSON assets shipped in `assets/music`).
 */

import musicalElementsJson from '../../assets/music/musical_elements.json';
import laVieEnRoseJson from '../../assets/music/scores/la_vie_en_rose_short.json';
import type { Note } from './synth.js';

export interface MusicalElements {
  notes_durations_denom: Record<string, number>;
  notes_key: Record<string, number>;
}

export interface Score {
  rythm: { tempo: number; timeSignatureNum: number; timeSignatureDenom: number };
  notes: Array<[string, string]>;
}

export const MUSICAL_ELEMENTS = musicalElementsJson as MusicalElements;
export const SCORES: Record<string, Score> = {
  laVieEnRose: laVieEnRoseJson as unknown as Score,
};

const SEMITONE = Math.pow(2, 1 / 12);

/** Piano key index -> frequency (Hz). Key 1 == A0 (27.5 Hz). */
export function keyToFreq(key: number): number {
  return 27.5 * Math.pow(SEMITONE, key - 1);
}

/** Frequency (Hz) -> nearest piano key index. */
export function freqToKey(freq: number): number {
  return Math.round(Math.log(freq / 27.5) / Math.log(SEMITONE) + 1);
}

/** Duration (seconds) of a named note value within a score's rhythm. */
export function noteDurationSec(
  score: Score,
  durationName: string,
  elements: MusicalElements,
): number {
  const denom = elements.notes_durations_denom[durationName] ?? 4;
  return (score.rythm.timeSignatureNum * (1 / denom) * 60) / score.rythm.tempo;
}

/** Convert a score into a flat list of synth notes. */
export function scoreToNotes(score: Score, elements: MusicalElements, amplitude = 0.5): Note[] {
  const out: Note[] = [];
  for (const [name, durName] of score.notes) {
    const key = elements.notes_key[name];
    const duration = noteDurationSec(score, durName, elements);
    const frequency = key === undefined || key < -1000 ? 0 : keyToFreq(key);
    out.push({ frequency, amplitude: frequency > 0 ? amplitude : 0, duration });
  }
  return out;
}
