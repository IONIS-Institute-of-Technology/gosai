import { describe, expect, test } from 'bun:test';
import { computeFit, fitCanvas, type FittableCanvas } from '../src/canvas.js';

describe('computeFit', () => {
  const reference = { width: 1920, height: 1080 };

  test('contain letterboxes a wider reference in a taller target', () => {
    const fit = computeFit({ width: 1000, height: 1000 }, reference, 'contain');
    expect(fit.scaleX).toBeCloseTo(1000 / 1920);
    expect(fit.scaleY).toBe(fit.scaleX);
    expect(fit.offsetX).toBeCloseTo(0);
    expect(fit.offsetY).toBeCloseTo((1000 - 1080 * (1000 / 1920)) / 2);
  });

  test('cover fills the target and centres the overflow', () => {
    const fit = computeFit({ width: 1000, height: 1000 }, reference, 'cover');
    expect(fit.scaleX).toBeCloseTo(1000 / 1080);
    expect(fit.scaleY).toBe(fit.scaleX);
    expect(fit.offsetX).toBeCloseTo((1000 - 1920 * (1000 / 1080)) / 2);
    expect(fit.offsetY).toBeCloseTo(0);
  });

  test('stretch scales each axis on its own', () => {
    expect(computeFit({ width: 960, height: 1080 }, reference, 'stretch')).toEqual({
      scaleX: 0.5,
      scaleY: 1,
      offsetX: 0,
      offsetY: 0,
    });
  });

  test('defaults to contain', () => {
    expect(computeFit({ width: 3840, height: 2160 }, reference)).toEqual({
      scaleX: 2,
      scaleY: 2,
      offsetX: 0,
      offsetY: 0,
    });
  });
});

/** A canvas stand-in that counts backing-store assignments. */
function fakeCanvas(cssWidth: number, cssHeight: number): FittableCanvas & { writes: number } {
  let width = 300;
  let height = 150;
  const canvas = {
    writes: 0,
    rect: { width: cssWidth, height: cssHeight },
    get width() {
      return width;
    },
    set width(value: number) {
      canvas.writes += 1;
      width = value;
    },
    get height() {
      return height;
    },
    set height(value: number) {
      canvas.writes += 1;
      height = value;
    },
    getBoundingClientRect: () => canvas.rect as DOMRect,
  };
  return canvas;
}

describe('fitCanvas', () => {
  test('sizes the backing store to the CSS box times the pixel ratio', () => {
    const canvas = fakeCanvas(800, 450.4);
    expect(fitCanvas(canvas, 2)).toBe(true);
    expect([canvas.width, canvas.height]).toEqual([1600, 901]);
  });

  test('does not touch the backing store when the size is unchanged', () => {
    const canvas = fakeCanvas(800, 450);
    fitCanvas(canvas, 1);
    const writes = canvas.writes;
    expect(fitCanvas(canvas, 1)).toBe(false);
    expect(fitCanvas(canvas, 1)).toBe(false);
    expect(canvas.writes).toBe(writes);
  });

  test('never sizes below one pixel', () => {
    const canvas = fakeCanvas(0, 0);
    fitCanvas(canvas, 1);
    expect([canvas.width, canvas.height]).toEqual([1, 1]);
  });
});
