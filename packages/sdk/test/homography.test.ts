import { describe, expect, test } from 'bun:test';
import {
  computeCSSMatrix3d,
  invertHomography,
  multiplyHomographies,
  perspectiveTransformPoint,
  perspectiveTransformPoints,
  quadToQuadHomography,
  type Point2D,
  type Quad,
} from '../src/homography.js';

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];

const UNIT_SQUARE: Quad = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
];

const SKEWED: Quad = [
  { x: 10, y: 20 },
  { x: 310, y: 5 },
  { x: 290, y: 240 },
  { x: -15, y: 200 },
];

function expectPoint(actual: Point2D | null, expected: Point2D): void {
  expect(actual).not.toBeNull();
  expect(actual!.x).toBeCloseTo(expected.x, 6);
  expect(actual!.y).toBeCloseTo(expected.y, 6);
}

function expectMatrix(actual: readonly number[], expected: readonly number[]): void {
  expect(actual).toHaveLength(9);
  actual.forEach((value, i) => expect(value).toBeCloseTo(expected[i]!, 6));
}

describe('perspectiveTransformPoint', () => {
  test('applies translation and scale', () => {
    const H = [2, 0, 5, 0, 3, -1, 0, 0, 1];
    expectPoint(perspectiveTransformPoint(H, 1, 2), { x: 7, y: 5 });
  });

  test('divides by the homogeneous coordinate', () => {
    const H = [1, 0, 0, 0, 1, 0, 0, 0, 2];
    expectPoint(perspectiveTransformPoint(H, 4, 6), { x: 2, y: 3 });
  });

  test('returns null for a point at infinity', () => {
    // w = x - 1, which is zero at x = 1.
    const H = [1, 0, 0, 0, 1, 0, 1, 0, -1];
    expect(perspectiveTransformPoint(H, 1, 5)).toBeNull();
    expect(perspectiveTransformPoint(H, 2, 5)).not.toBeNull();
  });

  test('perspectiveTransformPoints keeps indices and nulls', () => {
    const H = [1, 0, 0, 0, 1, 0, 1, 0, -1];
    const out = perspectiveTransformPoints(H, [
      { x: 2, y: 2 },
      { x: 1, y: 0 },
    ]);
    expect(out).toHaveLength(2);
    expectPoint(out[0]!, { x: 2, y: 2 });
    expect(out[1]).toBeNull();
  });
});

describe('quadToQuadHomography', () => {
  test('maps every source corner onto its destination corner', () => {
    const H = quadToQuadHomography(UNIT_SQUARE, SKEWED);
    UNIT_SQUARE.forEach((corner, i) => {
      expectPoint(perspectiveTransformPoint(H, corner.x, corner.y), SKEWED[i]!);
    });
  });

  test('identical quads give the identity', () => {
    expectMatrix(quadToQuadHomography(SKEWED, SKEWED), IDENTITY);
  });

  test('throws on a degenerate quad', () => {
    const collapsed: Quad = [
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 2 },
    ];
    expect(() => quadToQuadHomography(UNIT_SQUARE, collapsed)).toThrow();
  });
});

describe('invertHomography and multiplyHomographies', () => {
  test('a homography times its inverse is the identity', () => {
    const H = quadToQuadHomography(UNIT_SQUARE, SKEWED);
    expectMatrix(multiplyHomographies(H, invertHomography(H)), IDENTITY);
  });

  test('the inverse maps destination corners back', () => {
    const inverse = invertHomography(quadToQuadHomography(UNIT_SQUARE, SKEWED));
    SKEWED.forEach((corner, i) => {
      expectPoint(perspectiveTransformPoint(inverse, corner.x, corner.y), UNIT_SQUARE[i]!);
    });
  });

  test('the inverse is normalised so H[8] is 1', () => {
    expect(invertHomography([2, 0, 0, 0, 2, 0, 0, 0, 2])[8]).toBeCloseTo(1, 12);
  });

  test('composition applies the right-hand matrix first', () => {
    const scale = [2, 0, 0, 0, 2, 0, 0, 0, 1];
    const shift = [1, 0, 10, 0, 1, 0, 0, 0, 1];
    // shift * scale: scale first, then shift.
    expectPoint(perspectiveTransformPoint(multiplyHomographies(shift, scale), 1, 1), {
      x: 12,
      y: 2,
    });
  });

  test('throws on a singular matrix', () => {
    expect(() => invertHomography([1, 2, 3, 2, 4, 6, 0, 0, 0])).toThrow();
  });
});

/** Reads the 3x3 homography embedded in a CSS matrix3d string. */
function parseMatrix3d(css: string): { homography: number[]; rest: number[] } {
  const v = /^matrix3d\((.*)\)$/.exec(css)![1]!.split(',').map(Number);
  expect(v).toHaveLength(16);
  return {
    homography: [0, 4, 12, 1, 5, 13, 3, 7, 15].map((i) => v[i]!),
    rest: [2, 6, 8, 9, 10, 11, 14].map((i) => v[i]!),
  };
}

describe('computeCSSMatrix3d', () => {
  test('an unwarped box gives the identity matrix3d', () => {
    const box: Quad = [
      { x: 0, y: 0 },
      { x: 200, y: 0 },
      { x: 200, y: 100 },
      { x: 0, y: 100 },
    ];
    expectMatrix(parseMatrix3d(computeCSSMatrix3d(200, 100, box)).homography, IDENTITY);
  });

  test('embeds the homography column-major and leaves z alone', () => {
    const source: Quad = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 50 },
      { x: 0, y: 50 },
    ];
    const { homography, rest } = parseMatrix3d(computeCSSMatrix3d(100, 50, SKEWED));
    expectMatrix(homography, quadToQuadHomography(source, SKEWED));
    expect(rest).toEqual([0, 0, 0, 0, 1, 0, 0]);
  });
});
