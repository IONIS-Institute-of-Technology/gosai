/**
 * Homography (3x3 projective transform) utilities.
 *
 * Used to map between the three coordinate spaces that matter for the
 * camera/projector calibration pipeline:
 *
 *   C = camera image space (pixels or normalised 0..1)
 *   D = projector display space (pixels of the projector window)
 *   S = "surface" / table-reference space (canonical 1920x1080 used by apps)
 *
 * All matrices are 3x3 row-major flattened into `number[9]`:
 *
 *   [ H0 H1 H2 ]
 *   [ H3 H4 H5 ]
 *   [ H6 H7 H8 ]
 *
 * applied as:
 *
 *   X = H0*x + H1*y + H2
 *   Y = H3*x + H4*y + H5
 *   W = H6*x + H7*y + H8
 *   (x', y') = (X/W, Y/W)
 *
 * This matches OpenCV's `cv2.findHomography` / `cv2.perspectiveTransform`
 * convention, so matrices computed by the Python `calibration` driver are
 * directly consumable here without re-ordering.
 */

export interface Point2D {
  readonly x: number;
  readonly y: number;
}

/** A quadrilateral as 4 corners. Conventionally TL, TR, BR, BL. */
export type Quad = readonly [Point2D, Point2D, Point2D, Point2D];

/**
 * Apply a 3x3 row-major homography to a single point.
 * Returns `(0, 0)` if the homogeneous denominator collapses (degenerate point).
 */
export function perspectiveTransformPoint(H: ArrayLike<number>, x: number, y: number): Point2D {
  const w = H[6]! * x + H[7]! * y + H[8]!;
  if (Math.abs(w) < 1e-12) return { x: 0, y: 0 };
  return {
    x: (H[0]! * x + H[1]! * y + H[2]!) / w,
    y: (H[3]! * x + H[4]! * y + H[5]!) / w,
  };
}

/** Apply `H` to every point in `points`. */
export function perspectiveTransformPoints(
  H: ArrayLike<number>,
  points: readonly Point2D[],
): Point2D[] {
  return points.map((p) => perspectiveTransformPoint(H, p.x, p.y));
}

/**
 * Invert a 3x3 row-major homography via cofactors. Normalises the result so
 * `H[8] == 1` for stable downstream use. Throws on singular input.
 */
export function invertHomography(H: ArrayLike<number>): number[] {
  const a = H[0]!,
    b = H[1]!,
    c = H[2]!;
  const d = H[3]!,
    e = H[4]!,
    f = H[5]!;
  const g = H[6]!,
    h = H[7]!,
    i = H[8]!;

  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-12) {
    throw new Error('homography is singular and cannot be inverted');
  }
  const k = 1 / det;
  const inv = [
    (e * i - f * h) * k,
    (c * h - b * i) * k,
    (b * f - c * e) * k,
    (f * g - d * i) * k,
    (a * i - c * g) * k,
    (c * d - a * f) * k,
    (d * h - e * g) * k,
    (b * g - a * h) * k,
    (a * e - b * d) * k,
  ];
  // Normalise so the bottom-right element is 1 (matches OpenCV behaviour).
  if (Math.abs(inv[8]!) > 1e-12) {
    const s = 1 / inv[8]!;
    for (let j = 0; j < 9; j++) inv[j] = inv[j]! * s;
  }
  return inv;
}

/**
 * Compute the 3x3 row-major homography mapping 4 source corners to 4
 * destination corners. Uses Direct Linear Transform: builds an 8x8 linear
 * system from 4 correspondences (2 equations each, `H[8]` fixed to 1) and
 * solves via Gaussian elimination with partial pivoting.
 *
 * Throws if the 4 source or destination corners are collinear / coincident.
 */
export function quadToQuadHomography(src: Quad, dst: Quad): number[] {
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const sx = src[i]!.x;
    const sy = src[i]!.y;
    const dx = dst[i]!.x;
    const dy = dst[i]!.y;
    A.push([sx, sy, 1, 0, 0, 0, -dx * sx, -dx * sy]);
    b.push(dx);
    A.push([0, 0, 0, sx, sy, 1, -dy * sx, -dy * sy]);
    b.push(dy);
  }
  const h = solveLinearSystem(A, b);
  return [h[0]!, h[1]!, h[2]!, h[3]!, h[4]!, h[5]!, h[6]!, h[7]!, 1];
}

/**
 * Build a CSS `matrix3d(...)` string that maps an HTML element occupying
 * `(0, 0) -> (width, height)` (in its own CSS pixel box) onto an arbitrary
 * destination quadrilateral in its containing block.
 *
 * Apply with:
 *
 *   element.style.transformOrigin = '0 0';
 *   element.style.transform = computeCSSMatrix3d(w, h, quad);
 *
 * The destination corners are in the same order as the element's own
 * corners: [topLeft, topRight, bottomRight, bottomLeft].
 *
 * Internally embeds the 2D homography H (3x3, row-major) into a 4x4 CSS
 * transform matrix:
 *
 *   [ H0 H1 0 H2 ]
 *   [ H3 H4 0 H5 ]
 *   [  0  0 1  0 ]
 *   [ H6 H7 0 H8 ]
 *
 * then serialises in column-major order as required by the CSS spec.
 */
export function computeCSSMatrix3d(width: number, height: number, dstCorners: Quad): string {
  const src: Quad = [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: height },
    { x: 0, y: height },
  ];
  const H = quadToQuadHomography(src, dstCorners);
  const a = H[0]!,
    b = H[1]!,
    c = H[2]!;
  const d = H[3]!,
    e = H[4]!,
    f = H[5]!;
  const g = H[6]!,
    h = H[7]!,
    i = H[8]!;
  // Column-major serialisation of the embedded 4x4 matrix.
  return (
    'matrix3d(' + `${a},${d},0,${g},` + `${b},${e},0,${h},` + `0,0,1,0,` + `${c},${f},0,${i}` + ')'
  );
}

/**
 * Multiply two 3x3 row-major homographies: returns `A * B`. Useful when
 * composing camera->display with display->surface to get camera->surface
 * directly.
 */
export function multiplyHomographies(A: ArrayLike<number>, B: ArrayLike<number>): number[] {
  const out = new Array<number>(9).fill(0);
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      let sum = 0;
      for (let k = 0; k < 3; k++) {
        sum += A[row * 3 + k]! * B[k * 3 + col]!;
      }
      out[row * 3 + col] = sum;
    }
  }
  // Normalise.
  if (Math.abs(out[8]!) > 1e-12) {
    const s = 1 / out[8]!;
    for (let j = 0; j < 9; j++) out[j] = out[j]! * s;
  }
  return out;
}

/** Solve a square linear system `A x = b` via Gaussian elimination. */
function solveLinearSystem(A: number[][], b: number[]): number[] {
  const n = b.length;
  // Build augmented matrix [A | b].
  const M: number[][] = A.map((row, i) => {
    const aug = row.slice();
    aug.push(b[i]!);
    return aug;
  });
  for (let col = 0; col < n; col++) {
    // Partial pivoting: find the row with the largest |M[row][col]|.
    let pivot = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(M[row]![col]!) > Math.abs(M[pivot]![col]!)) pivot = row;
    }
    if (Math.abs(M[pivot]![col]!) < 1e-12) {
      throw new Error('linear system is singular (degenerate quad?)');
    }
    if (pivot !== col) {
      const tmp = M[col]!;
      M[col] = M[pivot]!;
      M[pivot] = tmp;
    }
    // Eliminate below the pivot.
    for (let row = col + 1; row < n; row++) {
      const factor = M[row]![col]! / M[col]![col]!;
      for (let k = col; k <= n; k++) {
        M[row]![k] = M[row]![k]! - factor * M[col]![k]!;
      }
    }
  }
  // Back-substitution.
  const x = new Array<number>(n).fill(0);
  for (let row = n - 1; row >= 0; row--) {
    let sum = M[row]![n]!;
    for (let k = row + 1; k < n; k++) sum -= M[row]![k]! * x[k]!;
    x[row] = sum / M[row]![row]!;
  }
  return x;
}
