/**
 * Music Training: sing or play to match a falling score.
 *
 * The dominant microphone pitch (from the `frequency_analysis` feed) places a
 * cursor on a piano-key strip. "Play La Vie En Rose" plays the melody on the
 * shared {@link Synth} and sends the same notes up the screen; keeping the
 * cursor on a note as it crosses the strip earns score. Notes move by elapsed
 * time, in step with the synth's clock-based schedule.
 */

import type { LayerDeps } from '../shared/deps.js';
import { drawText, strokeLine } from '../shared/draw.js';
import {
  drawKeyboard,
  freqToKey,
  LA_VIE_EN_ROSE,
  MUSICAL_ELEMENTS,
  noteDurationSec,
  scoreToNotes,
  type Score,
} from '../shared/music.js';
import { ParticleSystem } from '../shared/particles.js';
import { REF_HEIGHT, type Layer } from '../shared/types.js';

const SLUG = 'music-training';
const GAP = 10;
const SHIFT = 180;
const CURSOR_Y = 200;
/** How fast notes rise, in px/s. */
const NOTE_SPEED = 300;
/** Score points per second of matching, one per frame of the legacy 60 fps loop. */
const POINTS_PER_S = 60;
/** How close the cursor must be to a note, in px. */
const MATCH_PX = 6;
/** The `frequency_analysis` amplitude a sound needs to move the cursor. */
const AMP_GATE = 2;
const PARTICLE_LIFE_MS = 5000;
const PARTICLES_PER_S = 20;
const CYAN = { r: 0, g: 191, b: 255 };

export interface FallingNote {
  readonly x: number;
  /** Top of the note; it rises as time passes. */
  y: number;
  /** Length in px, proportional to the note's duration. */
  readonly length: number;
}

const keyToPx = (key: number): number =>
  (key + Math.floor((key - 4) / 12) + Math.floor((key - 9) / 12)) * GAP - SHIFT;

/** The notes of a score laid out below the screen, one after the other. */
export function layoutNotes(score: Score): FallingNote[] {
  let y = REF_HEIGHT;
  return score.notes.map(([name = '', durationName = '']) => {
    const key = MUSICAL_ELEMENTS.notes_key[name];
    const note = {
      x: key === undefined ? 0 : keyToPx(key),
      y,
      length: noteDurationSec(score, durationName) * NOTE_SPEED,
    };
    y += note.length;
    return note;
  });
}

/**
 * Moves the notes up by `deltaMs` and drops the ones that left the screen.
 * Returns the points earned: notes that reached the strip score while the
 * cursor sits on them. A `cursorX` of null means no pitch is detected.
 */
export function advanceNotes(
  notes: FallingNote[],
  deltaMs: number,
  cursorX: number | null,
): number {
  let points = 0;
  for (let i = notes.length - 1; i >= 0; i--) {
    const note = notes[i]!;
    note.y -= (NOTE_SPEED * deltaMs) / 1000;
    if (note.y < CURSOR_Y && matches(note, cursorX)) points += (POINTS_PER_S * deltaMs) / 1000;
    if (note.y + note.length < 0) notes.splice(i, 1);
  }
  return points;
}

function matches(note: FallingNote, cursorX: number | null): boolean {
  return cursorX !== null && Math.abs(note.x - cursorX) < MATCH_PX;
}

export function createMusicTrainingLayer(deps: LayerDeps): Layer {
  const particles = new ParticleSystem(PARTICLE_LIFE_MS);
  let notes: FallingNote[] = [];
  let score = 0;
  let unsubscribes: Array<() => void> = [];

  function stopTutorial(): void {
    deps.synth.stopScore();
    notes = [];
  }

  return {
    start(): void {
      particles.clear();
      notes = [];
      score = 0;
      unsubscribes = [
        deps.options.onTrigger(SLUG, 'Play La Vie En Rose', () => {
          deps.synth.playScore(scoreToNotes(LA_VIE_EN_ROSE, 0.5));
          notes = layoutNotes(LA_VIE_EN_ROSE);
          score = 0;
        }),
        deps.options.onTrigger(SLUG, 'Stop', stopTutorial),
      ];
    },

    render({ ctx, deltaMs }): void {
      if (deps.options.get(SLUG, 'Show bars')) {
        drawKeyboard(ctx, keyToPx, {
          y: CURSOR_Y,
          whiteWidth: GAP * 2.2,
          whiteHeight: 250,
          blackWidth: GAP * 1.2,
          blackHeight: 200,
        });
      }

      const { max_frequency, amplitude } = deps.feed.frequency.data;
      const cursorX =
        max_frequency > 30 && amplitude > AMP_GATE ? keyToPx(freqToKey(max_frequency)) : null;
      if (cursorX !== null) {
        ctx.fillStyle = 'rgb(0,191,255)';
        ctx.beginPath();
        ctx.arc(cursorX, CURSOR_Y, 8, 0, Math.PI * 2);
        ctx.fill();
        particles.emit(cursorX, CURSOR_Y, CYAN, PARTICLES_PER_S, deltaMs);
      }
      particles.run(ctx, deltaMs);

      score += advanceNotes(notes, deltaMs, cursorX);
      for (const note of notes) {
        const color = matches(note, cursorX) ? 'rgb(80,255,120)' : 'rgb(170,170,170)';
        strokeLine(ctx, note.x, note.y, note.x, note.y + note.length, 5, color);
      }
      if (notes.length > 0) {
        drawText(ctx, `Score: ${Math.floor(score)}`, 50, 120, 40, '#fff', 'left', 'middle');
      }
    },

    // The score can't pause in step with the synth, so sleep ends the tutorial.
    suspend: stopTutorial,

    stop(): void {
      for (const unsubscribe of unsubscribes) unsubscribe();
      unsubscribes = [];
      stopTutorial();
      particles.clear();
    },
  };
}
