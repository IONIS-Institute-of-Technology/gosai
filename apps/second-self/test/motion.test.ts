import { describe, expect, test } from 'bun:test';
import { advanceNotes, layoutNotes, type FallingNote } from '../src/layers/music-training.js';
import { LA_VIE_EN_ROSE } from '../src/shared/music.js';
import { stepParticle, type Particle } from '../src/shared/particles.js';
import { advanceSamplePosition } from '../src/layers/sign-training.js';

function particle(): Particle {
  return { x: 100, y: 500, vx: 10, vy: 0, life: 1000, color: { r: 0, g: 0, b: 0 } };
}

describe('particles', () => {
  test('move the same distance whatever the frame rate', () => {
    const at60 = particle();
    const at30 = particle();
    for (let i = 0; i < 30; i++) stepParticle(at60, 1000 / 60);
    for (let i = 0; i < 15; i++) stepParticle(at30, 1000 / 30);
    expect(at30.x).toBeCloseTo(at60.x, 6);
    expect(at30.y).toBeCloseTo(at60.y, 6);
    expect(at30.vy).toBeCloseTo(at60.vy, 6);
    expect(at30.life).toBeCloseTo(at60.life, 6);
  });

  test('rise, drift and die on time', () => {
    const p = particle();
    expect(stepParticle(p, 500)).toBe(true);
    expect(p.x).toBeCloseTo(105);
    expect(p.y).toBeLessThan(500);
    expect(stepParticle(p, 500)).toBe(false);
  });
});

describe('music training notes', () => {
  function notes(): FallingNote[] {
    return [
      { x: 100, startY: 1000, y: 1000, length: 200 },
      { x: 300, startY: 1200, y: 1200, length: 100 },
    ];
  }

  test('sit where the audio clock says, however the frames fell', () => {
    const smooth = notes();
    for (let i = 1; i <= 60; i++) advanceNotes(smooth, i / 60, 1 / 60, null);
    const stalled = notes();
    // One long frame, as after a stall.
    advanceNotes(stalled, 1, 1, null);
    expect(stalled.map((n) => n.y)).toEqual(smooth.map((n) => expect.closeTo(n.y, 6)));
    expect(smooth[0]!.y).toBeCloseTo(700);
  });

  test('score by the time the cursor holds a note past the strip', () => {
    const run = (fps: number): number => {
      const list: FallingNote[] = [{ x: 100, startY: 150, y: 150, length: 400 }];
      let points = 0;
      for (let i = 1; i <= fps; i++) points += advanceNotes(list, i / fps, 1 / fps, 100);
      return points;
    };
    expect(run(60)).toBeCloseTo(60);
    expect(run(20)).toBeCloseTo(60);
    const note = (): FallingNote[] => [{ x: 100, startY: 150, y: 150, length: 400 }];
    expect(advanceNotes(note(), 0.1, 0.016, 400)).toBe(0);
    expect(advanceNotes(note(), 0.1, 0.016, null)).toBe(0);
  });

  test('drop notes that left the screen', () => {
    const list: FallingNote[] = [{ x: 0, startY: 10, y: 10, length: 20 }];
    advanceNotes(list, 1, 1, null);
    expect(list).toEqual([]);
  });

  test('lay a score out end to end below the screen', () => {
    const laidOut = layoutNotes(LA_VIE_EN_ROSE);
    expect(laidOut).toHaveLength(LA_VIE_EN_ROSE.notes.length);
    expect(laidOut[0]!.startY).toBe(1920);
    for (let i = 1; i < laidOut.length; i++) {
      expect(laidOut[i]!.startY).toBeCloseTo(laidOut[i - 1]!.startY + laidOut[i - 1]!.length);
    }
  });
});

describe('sign training correction', () => {
  test('replays the 30 sample frames in half a second', () => {
    let position = 0;
    for (let i = 0; i < 30; i++) position = advanceSamplePosition(position, 1000 / 60);
    expect(position).toBeCloseTo(30);
  });

  test('never skips a sample frame on a long frame', () => {
    expect(advanceSamplePosition(0, 100)).toBe(1);
    expect(advanceSamplePosition(2.5, 100)).toBe(3);
    expect(advanceSamplePosition(2, 8)).toBeCloseTo(2.48);
  });
});
