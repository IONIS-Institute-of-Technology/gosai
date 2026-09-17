import { describe, expect, test } from 'bun:test';
import type { Quad } from '../src/homography.js';
import { applyQuadWarp, clearQuadWarp, type WarpTarget } from '../src/warp.js';

function fakeElement(): WarpTarget & { style: Record<string, string> } {
  return {
    style: {
      position: '',
      left: '',
      top: '',
      right: '',
      bottom: '',
      width: '100%',
      height: '100%',
      transform: '',
      transformOrigin: '',
      backfaceVisibility: '',
    },
    parentElement: { clientWidth: 1920, clientHeight: 1080 },
  };
}

const QUAD: Quad = [
  { x: 100, y: 50 },
  { x: 1800, y: 0 },
  { x: 1900, y: 1000 },
  { x: 0, y: 1080 },
];

describe('applyQuadWarp', () => {
  test('pins the element to its parent size and sets a matrix3d transform', () => {
    const el = fakeElement();
    applyQuadWarp(el, QUAD);
    expect(el.style.width).toBe('1920px');
    expect(el.style.height).toBe('1080px');
    expect(el.style.position).toBe('absolute');
    expect(el.style.transformOrigin).toBe('0 0');
    expect(el.style.transform).toStartWith('matrix3d(');
  });

  test('uses an explicit size when given', () => {
    const el = fakeElement();
    applyQuadWarp(el, QUAD, { width: 1280, height: 720 });
    expect([el.style.width, el.style.height]).toEqual(['1280px', '720px']);
  });

  test('clearQuadWarp restores the original inline styles, even after re-warping', () => {
    const el = fakeElement();
    const before = { ...el.style };
    applyQuadWarp(el, QUAD);
    applyQuadWarp(el, QUAD, { width: 640, height: 360 });
    clearQuadWarp(el);
    expect(el.style).toEqual(before);
  });

  test('a degenerate quad throws and leaves the element untouched', () => {
    const el = fakeElement();
    const before = { ...el.style };
    const collapsed: Quad = [
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 0, y: 0 },
    ];
    expect(() => applyQuadWarp(el, collapsed)).toThrow();
    expect(el.style).toEqual(before);
    clearQuadWarp(el);
    expect(el.style).toEqual(before);
  });
});
