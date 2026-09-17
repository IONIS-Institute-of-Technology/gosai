import { describe, expect, test } from 'bun:test';
import { createMirrorFeed } from '../src/shared/feed.js';
import type { MirroredData } from '../src/shared/types.js';
import {
  cssViewport,
  CursorPicker,
  dist,
  drawHoverButton,
  drawProgressRing,
  inRect,
  roundRect,
  stepDwell,
} from '../src/shared/ui.js';

/** A 2D context that records the methods called on it. */
function recordingContext(): { ctx: CanvasRenderingContext2D; calls: Array<[string, unknown[]]> } {
  const calls: Array<[string, unknown[]]> = [];
  const state: Record<string | symbol, unknown> = { globalAlpha: 1 };
  const ctx = new Proxy(state, {
    get(target, prop) {
      if (prop in target) return target[prop];
      return (...args: unknown[]) => void calls.push([String(prop), args]);
    },
    set(target, prop, value) {
      target[prop] = value;
      return true;
    },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

function mirror(hands: { right?: [number, number]; left?: [number, number] }): MirroredData {
  const data = createMirrorFeed().mirror.data;
  const hand = (tip?: [number, number]): number[][] =>
    tip
      ? Array.from({ length: 21 }, (_, i) => (i === 8 ? [tip[0], tip[1], 0, 1] : [0, 0, 0, 1]))
      : [];
  return { ...data, right_hand_pose: hand(hands.right), left_hand_pose: hand(hands.left) };
}

describe('geometry', () => {
  test('cssViewport converts the fitted reference space to CSS pixels', () => {
    // A 1080x1920 reference letterboxed into a 2160x1080 backing store at 2x DPR.
    const fit = { scaleX: 0.5625, scaleY: 0.5625, offsetX: 776.25, offsetY: 0 };
    expect(cssViewport(fit, { width: 1080, height: 1920 }, 0.5)).toEqual({
      x: 388.125,
      y: 0,
      width: 303.75,
      height: 540,
    });
  });

  test('dist', () => {
    expect(dist(0, 0, 3, 4)).toBe(5);
  });

  test('inRect honours the padding and a missing cursor', () => {
    const rect = { x: 10, y: 10, w: 100, h: 50 };
    expect(inRect({ x: 50, y: 30 }, rect)).toBe(true);
    expect(inRect({ x: 5, y: 30 }, rect)).toBe(false);
    expect(inRect({ x: 5, y: 30 }, rect, 10)).toBe(true);
    expect(inRect(null, rect, 100)).toBe(false);
  });

  test('stepDwell grows while hovered and decays faster otherwise', () => {
    expect(stepDwell(100, true, 16)).toBe(116);
    expect(stepDwell(100, false, 16)).toBe(68);
    expect(stepDwell(10, false, 16)).toBe(0);
    expect(stepDwell(100, false, 16, 1)).toBe(84);
  });
});

describe('drawing', () => {
  test('roundRect clamps the radius to the box', () => {
    const { ctx, calls } = recordingContext();
    roundRect(ctx, 0, 0, 20, 10, 16);
    expect(calls).toEqual([
      ['beginPath', []],
      ['roundRect', [0, 0, 20, 10, 5]],
    ]);
  });

  test('drawProgressRing draws nothing without progress', () => {
    const { ctx, calls } = recordingContext();
    drawProgressRing(ctx, 0, 0, 10, 0, { color: '#fff' });
    drawProgressRing(ctx, 0, 0, 10, Number.NaN, { color: '#fff' });
    expect(calls).toEqual([]);
  });

  test('drawProgressRing strokes an arc or fills a pie from twelve o’clock', () => {
    const arc = recordingContext();
    drawProgressRing(arc.ctx, 5, 6, 10, 0.25, { color: '#fff', lineWidth: 8 });
    expect(arc.calls.map(([name]) => name)).toEqual(['beginPath', 'arc', 'stroke']);
    expect(arc.calls[1]![1]).toEqual([5, 6, 10, -Math.PI / 2, 0]);
    expect(arc.ctx.lineWidth).toBe(8);

    const pie = recordingContext();
    drawProgressRing(pie.ctx, 5, 6, 10, 2, { color: '#fff', fill: true });
    expect(pie.calls.map(([name]) => name)).toEqual([
      'beginPath',
      'moveTo',
      'arc',
      'closePath',
      'fill',
    ]);
    expect(pie.calls[2]![1]).toEqual([5, 6, 10, -Math.PI / 2, (3 * Math.PI) / 2]);
  });

  test('drawHoverButton fills progress only when there is some', () => {
    const idle = recordingContext();
    drawHoverButton(idle.ctx, { x: 0, y: 0, w: 100, h: 40 }, 'Save', 0, { color: '#0f0' });
    expect(idle.calls.filter(([name]) => name === 'fill')).toHaveLength(1);
    expect(idle.calls.at(-1)).toEqual(['fillText', ['Save', 50, 20]]);

    const half = recordingContext();
    drawHoverButton(half.ctx, { x: 0, y: 0, w: 100, h: 40 }, 'Save', 0.5, { color: '#0f0' });
    const rects = half.calls.filter(([name]) => name === 'roundRect').map(([, args]) => args[2]);
    expect(rects).toEqual([100, 50]);
    // The translucent progress fill is scoped by save/restore.
    const names = half.calls.map(([name]) => name);
    expect(names.indexOf('save')).toBeLessThan(names.lastIndexOf('fill'));
    expect(names.indexOf('restore')).toBeGreaterThan(names.lastIndexOf('fill'));
  });
});

describe('CursorPicker', () => {
  test('follows the higher hand, then sticks to it', () => {
    const picker = new CursorPicker({ switchMarginPx: 80, switchMs: 400 });
    expect(picker.pick(mirror({ right: [100, 500], left: [900, 300] }), 1000)).toEqual({
      x: 900,
      y: 300,
    });
    // The right hand is now higher, but not clearly enough.
    expect(picker.pick(mirror({ right: [100, 250], left: [900, 300] }), 1100)).toEqual({
      x: 900,
      y: 300,
    });
    // Clearly higher, but not for long enough.
    expect(picker.pick(mirror({ right: [100, 100], left: [900, 300] }), 1200)).toEqual({
      x: 900,
      y: 300,
    });
    expect(picker.pick(mirror({ right: [100, 100], left: [900, 300] }), 1500)).toEqual({
      x: 900,
      y: 300,
    });
    expect(picker.pick(mirror({ right: [100, 100], left: [900, 300] }), 1600)).toEqual({
      x: 100,
      y: 100,
    });
  });

  test('keeps the last position through a short dropout', () => {
    const picker = new CursorPicker({ graceMs: 300 });
    picker.pick(mirror({ right: [100, 500] }), 1000);
    expect(picker.pick(mirror({}), 1200)).toEqual({ x: 100, y: 500 });
    expect(picker.pick(mirror({}), 1400)).toBeNull();
  });

  test('falls back to the body index fingertips when asked', () => {
    const data = mirror({});
    data.body_pose = Array.from({ length: 33 }, (_, i) =>
      i === 19 ? [40, 50, 0, 1] : [0, 0, 0, 1],
    );
    expect(new CursorPicker().pick(data, 1000)).toBeNull();
    expect(new CursorPicker({ bodyFallback: true }).pick(data, 1000)).toEqual({ x: 40, y: 50 });
  });
});
