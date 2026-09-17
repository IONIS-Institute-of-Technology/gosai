import { describe, expect, test } from 'bun:test';
import { advanceNotes, layoutNotes, type FallingNote } from '../src/layers/music-training.js';
import { LA_VIE_EN_ROSE } from '../src/shared/music.js';
import { stepParticle, type Particle } from '../src/shared/particles.js';

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
      { x: 100, y: 1000, length: 200 },
      { x: 300, y: 1200, length: 100 },
    ];
  }

  test('rise by elapsed time', () => {
    const at60 = notes();
    const at20 = notes();
    for (let i = 0; i < 60; i++) advanceNotes(at60, 1000 / 60, null);
    for (let i = 0; i < 20; i++) advanceNotes(at20, 1000 / 20, null);
    expect(at20.map((n) => n.y)).toEqual(at60.map((n) => expect.closeTo(n.y, 6)));
    expect(at60[0]!.y).toBeCloseTo(700);
  });

  test('score by the time the cursor holds a note past the strip', () => {
    const list: FallingNote[] = [{ x: 100, y: 150, length: 400 }];
    const at60 = Array.from({ length: 60 }, () => advanceNotes(list, 1000 / 60, 100)).reduce(
      (a, b) => a + b,
    );
    const other: FallingNote[] = [{ x: 100, y: 150, length: 400 }];
    const at30 = Array.from({ length: 30 }, () => advanceNotes(other, 1000 / 30, 100)).reduce(
      (a, b) => a + b,
    );
    expect(at60).toBeCloseTo(60);
    expect(at30).toBeCloseTo(at60);
    expect(advanceNotes([{ x: 100, y: 150, length: 400 }], 16, 400)).toBe(0);
    expect(advanceNotes([{ x: 100, y: 150, length: 400 }], 16, null)).toBe(0);
  });

  test('drop notes that left the screen', () => {
    const list: FallingNote[] = [{ x: 0, y: 10, length: 20 }];
    advanceNotes(list, 1000, null);
    expect(list).toEqual([]);
  });

  test('lay a score out end to end below the screen', () => {
    const laidOut = layoutNotes(LA_VIE_EN_ROSE);
    expect(laidOut).toHaveLength(LA_VIE_EN_ROSE.notes.length);
    expect(laidOut[0]!.y).toBe(1920);
    for (let i = 1; i < laidOut.length; i++) {
      expect(laidOut[i]!.y).toBeCloseTo(laidOut[i - 1]!.y + laidOut[i - 1]!.length);
    }
  });
});
