/**
 * Music Training: sing/play to match a falling score.
 *
 * Ports the legacy `music_training` app (components/music_training.js). The
 * dominant microphone pitch (from the `frequency_analysis` feed) places a
 * cursor on a piano-key strip. "Play La Vie En Rose" both plays the melody via
 * the shared {@link Synth} and spawns falling target notes; matching them with
 * your voice earns score.
 */

import { drawText, strokeLine } from '../shared/canvas.js';
import type { LayerDeps } from '../shared/deps.js';
import { fillRect, strokeRect } from '../shared/canvas.js';
import {
  freqToKey,
  MUSICAL_ELEMENTS,
  noteDurationSec,
  scoreToNotes,
  SCORES,
} from '../shared/music.js';
import { ParticleSystem } from '../shared/particles.js';
import { REF_HEIGHT, type FrameContext, type Layer } from '../shared/types.js';

const GAP = 10;
const SHIFT = 180;
const CURSOR_Y = 200;
const NOTE_SPEED = 5; // px per frame (legacy ~60fps reference).
const AMP_GATE = 2;

interface FallingNote {
  x: number;
  y: number;
  distance: number;
  score: number;
  scored: boolean;
}

export function createMusicTrainingLayer(deps: LayerDeps): Layer {
  const particles = new ParticleSystem(300);
  let fallingNotes: FallingNote[] = [];
  let totalScore = 0;
  let cursorX = 0;
  const unsubscribes: Array<() => void> = [];

  const keyToPxl = (key: number): number =>
    (key + Math.floor((key - 4) / 12) + Math.floor((key - 9) / 12)) * GAP - SHIFT;

  function spawnTutorial(): void {
    const score = SCORES.laVieEnRose!;
    const notes: FallingNote[] = [];
    let lineY = REF_HEIGHT;
    for (const [name, durName] of score.notes) {
      const dur = noteDurationSec(score, durName, MUSICAL_ELEMENTS);
      const distance = dur * NOTE_SPEED * 60;
      const key = MUSICAL_ELEMENTS.notes_key[name];
      const x = key === undefined ? 0 : keyToPxl(key);
      notes.push({ x, y: lineY, distance, score: 0, scored: false });
      lineY += distance;
    }
    fallingNotes = notes;
    totalScore = 0;
  }

  return {
    start(): void {
      particles.clear();
      fallingNotes = [];
      totalScore = 0;
      cursorX = 0;
      unsubscribes.push(
        deps.controller.onOption('music-training', 'Play La Vie En Rose', () => {
          deps.synth.playScore(scoreToNotes(SCORES.laVieEnRose!, MUSICAL_ELEMENTS, 0.5));
          spawnTutorial();
        }),
        deps.controller.onOption('music-training', 'Stop', () => {
          deps.synth.stopScore();
          fallingNotes = [];
        }),
      );
    },

    render(frame: FrameContext): void {
      const { ctx } = frame;
      const showBars = deps.controller.getOption('music-training', 'Show bars');
      if (showBars) drawBars(ctx, keyToPxl);

      const f = deps.feed.frequency.data;
      if (f.max_frequency > 30 && f.amplitude > AMP_GATE) {
        const key = freqToKey(f.max_frequency);
        cursorX = keyToPxl(key);
        ctx.fillStyle = 'rgb(0,191,255)';
        ctx.beginPath();
        ctx.arc(cursorX, CURSOR_Y, 8, 0, Math.PI * 2);
        ctx.fill();
        if (Math.floor(Math.random() * 3) === 0)
          particles.add(cursorX, CURSOR_Y, { r: 0, g: 191, b: 255 });
      } else {
        cursorX = 0;
      }
      particles.run(ctx);

      updateFallingNotes(ctx);

      if (fallingNotes.length > 0) {
        drawText(ctx, `Score: ${totalScore}`, 50, 120, 40, '#fff', 'left', 'middle');
      }
    },

    stop(): void {
      for (const u of unsubscribes) u();
      unsubscribes.length = 0;
      deps.synth.stopScore();
      particles.clear();
      fallingNotes = [];
    },
  };

  function updateFallingNotes(ctx: CanvasRenderingContext2D): void {
    for (let i = fallingNotes.length - 1; i >= 0; i--) {
      const n = fallingNotes[i]!;
      n.y -= NOTE_SPEED;
      const validating = Math.abs(n.x - cursorX) < 6 && cursorX !== 0;
      if (n.y < CURSOR_Y && !n.scored && validating) {
        n.score += 1;
        totalScore += 1;
      }
      const color = validating ? 'rgb(80,255,120)' : 'rgb(170,170,170)';
      strokeLine(ctx, n.x, n.y, n.x, n.y + n.distance, 5, color);
      if (n.y + n.distance < 0) fallingNotes.splice(i, 1);
    }
  }
}

function drawBars(ctx: CanvasRenderingContext2D, keyToPxl: (k: number) => number): void {
  const keys = MUSICAL_ELEMENTS.notes_key;
  for (const note of Object.keys(keys)) {
    if (note.includes('#') || keys[note]! < 0) continue;
    const x = keyToPxl(keys[note]!);
    const w = GAP * 2.2;
    fillRect(ctx, x - w / 2, CURSOR_Y, w, 250, 'rgba(255,255,255,0.9)');
    strokeRect(ctx, x - w / 2, CURSOR_Y, w, 250, 2, '#000');
  }
  for (const note of Object.keys(keys)) {
    if (!note.includes('#')) continue;
    const x = keyToPxl(keys[note]!);
    const w = GAP * 1.2;
    fillRect(ctx, x - w / 2, CURSOR_Y, w, 200, 'rgb(16,16,16)');
  }
}
