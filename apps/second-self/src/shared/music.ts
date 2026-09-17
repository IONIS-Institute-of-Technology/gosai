/**
 * Musical helpers shared by the theremine and music-training layers: note,
 * frequency and duration math, the bundled note table and scores, and the
 * piano keyboard both layers draw.
 */

import musicalElementsJson from '../../assets/music/musical_elements.json';
import laVieEnRoseJson from '../../assets/music/scores/la_vie_en_rose_short.json';
import { fillRect, strokeRect } from './draw.js';
import type { Note } from './synth.js';

interface MusicalElements {
  readonly notes_durations_denom: Readonly<Record<string, number>>;
  readonly notes_key: Readonly<Record<string, number>>;
}

export interface Score {
  readonly rythm: { readonly tempo: number; readonly timeSignatureNum: number };
  /** `[note name, duration name]` pairs. */
  readonly notes: readonly (readonly string[])[];
}

export const MUSICAL_ELEMENTS: MusicalElements = musicalElementsJson;
export const LA_VIE_EN_ROSE: Score = laVieEnRoseJson;

const SEMITONE = Math.pow(2, 1 / 12);

/** Piano key index to frequency (Hz). Key 1 is A0 (27.5 Hz). */
export function keyToFreq(key: number): number {
  return 27.5 * Math.pow(SEMITONE, key - 1);
}

/** Frequency (Hz) to the nearest piano key index. */
export function freqToKey(freq: number): number {
  return Math.round(Math.log(freq / 27.5) / Math.log(SEMITONE) + 1);
}

/** Duration (seconds) of a named note value within a score's rhythm. */
export function noteDurationSec(score: Score, durationName: string): number {
  const denom = MUSICAL_ELEMENTS.notes_durations_denom[durationName] ?? 4;
  return (score.rythm.timeSignatureNum * (1 / denom) * 60) / score.rythm.tempo;
}

/** Converts a score into a flat list of synth notes. */
export function scoreToNotes(score: Score, amplitude = 0.5): Note[] {
  return score.notes.map(([name = '', durationName = '']) => {
    const key = MUSICAL_ELEMENTS.notes_key[name];
    const frequency = key === undefined || key < 0 ? 0 : keyToFreq(key);
    return {
      frequency,
      amplitude: frequency > 0 ? amplitude : 0,
      duration: noteDurationSec(score, durationName),
    };
  });
}

export interface KeyboardStyle {
  readonly y: number;
  readonly whiteWidth: number;
  readonly whiteHeight: number;
  readonly blackWidth: number;
  readonly blackHeight: number;
  /** Length of the faint guide line below each white key, if any. */
  readonly guideLength?: number;
}

/** Draws the piano keys of the note table, placed along x by `keyToPx`. */
export function drawKeyboard(
  ctx: CanvasRenderingContext2D,
  keyToPx: (key: number) => number,
  style: KeyboardStyle,
): void {
  const keys = Object.entries(MUSICAL_ELEMENTS.notes_key).filter(([, key]) => key >= 0);
  for (const [note, key] of keys) {
    if (note.includes('#')) continue;
    const x = keyToPx(key);
    if (style.guideLength) {
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.fillRect(x - 1, style.y, 2, style.guideLength);
    }
    const left = x - style.whiteWidth / 2;
    fillRect(ctx, left, style.y, style.whiteWidth, style.whiteHeight, 'rgba(255,255,255,0.9)');
    strokeRect(ctx, left, style.y, style.whiteWidth, style.whiteHeight, 2, '#000');
  }
  for (const [note, key] of keys) {
    if (!note.includes('#')) continue;
    const left = keyToPx(key) - style.blackWidth / 2;
    fillRect(ctx, left, style.y, style.blackWidth, style.blackHeight, 'rgb(16,16,16)');
  }
}
