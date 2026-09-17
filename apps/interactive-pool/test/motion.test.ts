import { describe, expect, test } from 'bun:test';
import { moveRabbit, type Rabbit } from '../src/layers/rabbits-game.js';
import {
  LEGACY_FRAME_MS,
  frameSteps,
  stepParticle,
  wrap,
  type Particle,
} from '../src/shared/motion.js';

function particle(): Particle {
  return { x: 100, y: 100, vx: 4, vy: -2, alpha: 255 };
}

function rabbit(): Rabbit {
  return {
    x: 500,
    y: 500,
    r: 50,
    xSpeed: 2,
    ySpeed: 1,
    angle: 0,
    alpha: 255,
    alive: true,
    deathTime: 0,
    particles: [],
  };
}

describe('motion', () => {
  test('one legacy frame is a 60 fps frame', () => {
    expect(frameSteps(LEGACY_FRAME_MS)).toBeCloseTo(1);
    expect(frameSteps(50)).toBeCloseTo(3);
    expect(frameSteps(-5)).toBe(0);
  });

  test('a particle covers the same ground at 30 fps and 60 fps', () => {
    const at60 = particle();
    const at30 = particle();
    for (let i = 0; i < 60; i++) stepParticle(at60, frameSteps(1000 / 60), 0.98, 0.99);
    for (let i = 0; i < 30; i++) stepParticle(at30, frameSteps(1000 / 30), 0.98, 0.99);
    // Drag and fade are exact; position integrates the drag per step, so it
    // only agrees closely.
    expect(at30.vx).toBeCloseTo(at60.vx, 10);
    expect(at30.alpha).toBeCloseTo(at60.alpha, 10);
    expect(at30.x).toBeCloseTo(at60.x, -1);
  });

  test('wrap jumps to the opposite edge', () => {
    expect(wrap(1930, 1920)).toBe(0);
    expect(wrap(-1, 1920)).toBe(1920);
    expect(wrap(12, 1920)).toBe(12);
  });

  test('rabbits move and spin by frame time', () => {
    const at60 = rabbit();
    const at20 = rabbit();
    for (let i = 0; i < 6; i++) moveRabbit(at60, frameSteps(1000 / 60));
    for (let i = 0; i < 2; i++) moveRabbit(at20, frameSteps(1000 / 20));
    expect(at20.x).toBeCloseTo(at60.x);
    expect(at20.y).toBeCloseTo(at60.y);
    expect(at20.angle).toBeCloseTo(at60.angle);
    expect(at60.x).toBeCloseTo(512);
  });

  test('a dead rabbit stays put while its ghost fades', () => {
    const dead = { ...rabbit(), alive: false };
    moveRabbit(dead, 4);
    expect(dead.x).toBe(500);
    expect(dead.alpha).toBe(253);
  });
});
