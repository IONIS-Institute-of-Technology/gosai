/**
 * Vector and geometry helpers shared between layers (affine, triangles, etc).
 *
 * Ported from the legacy p5 helpers (`dist`, `createVector`, `intersect_point`,
 * `calculateAngle`) but framework-agnostic.
 */

export interface Vec2 {
  x: number;
  y: number;
}

/** Euclidean distance between two points. */
export function dist(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.hypot(dx, dy);
}

/** Round to 5 decimal places (matches legacy `round(value, 5)`). */
export function round5(value: number): number {
  return Math.round(value * 1e5) / 1e5;
}

/** Round to nearest integer (legacy `round(value)`). */
export function roundInt(value: number): number {
  return Math.round(value);
}

/** Midpoint of segment [a, b]. */
export function midpoint(a: Vec2, b: Vec2): Vec2 {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/**
 * Law-of-cosines angle (in degrees) of triangle vertex `at`, given vertices
 * `prev`, `at`, and `next` (legacy `calculateAngle` semantics).
 */
export function triangleAngleDeg(prev: Vec2, at: Vec2, next: Vec2): number {
  const ab = round5(dist(prev, at));
  const bc = round5(dist(at, next));
  const ac = round5(dist(prev, next));
  if (ab === 0 || bc === 0) return 0;
  const cosA = (bc * bc + ab * ab - ac * ac) / (2 * bc * ab);
  // Clamp to [-1, 1] for numerical safety.
  const clamped = Math.max(-1, Math.min(1, cosA));
  return Math.round((Math.acos(clamped) * 180) / Math.PI);
}

/**
 * Returns a point obtained by rotating the vector (vertex - midpoint) by
 * 90 degrees and re-anchoring at midpoint. This generates one extremity
 * of the perpendicular bisector of side `[midpoint, vertex]`.
 */
export function perpendicularExtremity(mid: Vec2, vertex: Vec2): Vec2 {
  const u = { x: vertex.x - mid.x, y: vertex.y - mid.y };
  // Rotate 90deg counter-clockwise.
  const v = { x: -u.y, y: u.x };
  return { x: v.x + mid.x, y: v.y + mid.y };
}

/**
 * Mirror `p` across `center` -- gives the opposite extremity for our
 * perpendicular-bisector segment.
 */
export function mirror(p: Vec2, center: Vec2): Vec2 {
  return { x: 2 * center.x - p.x, y: 2 * center.y - p.y };
}

/**
 * Intersection of lines (p1->p2) and (p3->p4). Returns null when the lines
 * are parallel. Ported from the legacy `intersect_point` function.
 */
export function lineIntersection(p1: Vec2, p2: Vec2, p3: Vec2, p4: Vec2): Vec2 | null {
  const denom = (p4.y - p3.y) * (p2.x - p1.x) - (p4.x - p3.x) * (p2.y - p1.y);
  if (denom === 0) return null;
  const ua = ((p4.x - p3.x) * (p1.y - p3.y) - (p4.y - p3.y) * (p1.x - p3.x)) / denom;
  return { x: p1.x + ua * (p2.x - p1.x), y: p1.y + ua * (p2.y - p1.y) };
}

/** Random number in [min, max). */
export function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/** Pick a random element from a non-empty array. */
export function pick<T>(arr: readonly T[]): T {
  if (arr.length === 0) throw new Error('pick: empty array');
  return arr[Math.floor(Math.random() * arr.length)]!;
}

/** Clamp `v` to [lo, hi]. */
export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
