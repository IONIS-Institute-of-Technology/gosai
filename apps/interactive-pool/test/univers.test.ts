import { describe, expect, test } from 'bun:test';
import {
  createGalaxy,
  createSolarSystem,
  drawGalaxy,
  drawSolarSystem,
  planetOffset,
  scatterPoints,
  starPosition,
  syncSolarSystems,
  type SolarSystem,
} from '../src/layers/univers.js';
import type { Ball } from '../src/shared/types.js';

function ball(x: number, y: number): Ball {
  return { x, y, diameter: 80, vx: 0, vy: 0 };
}

/** Records the ellipses and arcs drawn, ignoring everything else. */
function recordingContext() {
  const ellipses: Array<{ x: number; y: number; rx: number; ry: number; stroke: number }> = [];
  const arcs: Array<{ x: number; y: number; r: number }> = [];
  let strokes = 0;
  let fills = 0;
  const ctx = new Proxy(
    {
      ellipse: (x: number, y: number, rx: number, ry: number) =>
        ellipses.push({ x, y, rx, ry, stroke: strokes }),
      arc: (x: number, y: number, r: number) => arcs.push({ x, y, r }),
      stroke: () => {
        strokes += 1;
      },
      fill: () => {
        fills += 1;
      },
    },
    {
      get: (target, key) => (key in target ? target[key as keyof typeof target] : () => undefined),
      set: () => true,
    },
  ) as unknown as CanvasRenderingContext2D;
  return { ctx, ellipses, arcs, strokes: () => strokes, fills: () => fills };
}

describe('univers', () => {
  test('precomputed star positions match the legacy rotate-then-orbit placement', () => {
    const count = 50;
    const galaxy = createGalaxy(count);
    const angle = 0.7;
    for (const i of [0, 1, 17, 49]) {
      const radiusW = 5 + i * 0.2;
      const radiusH = radiusW / 2;
      const theta = (galaxy.phase[i] ?? 0) + angle;
      const lx = (radiusW / 2) * Math.cos(theta);
      const ly = (radiusH / 2) * Math.sin(theta);
      const spiral = (Math.PI / count) * i;
      const expected = {
        x: lx * Math.cos(spiral) - ly * Math.sin(spiral),
        y: lx * Math.sin(spiral) + ly * Math.cos(spiral),
      };
      const actual = starPosition(galaxy, i, angle);
      expect(actual.x).toBeCloseTo(expected.x, 10);
      expect(actual.y).toBeCloseTo(expected.y, 10);
    }
  });

  test('the galaxy draws every star once, in interleaved batches', () => {
    const galaxy = createGalaxy(100);
    const { ctx, arcs, fills } = recordingContext();
    drawGalaxy(ctx, galaxy, 0.2);
    expect(fills()).toBe(8);
    expect(arcs).toHaveLength(100);
    const first = starPosition(galaxy, 0, 0.2);
    expect(arcs[0]?.x).toBeCloseTo(960 + first.x);
    expect(arcs[0]?.y).toBeCloseTo(540 + first.y);
  });

  test('background dots stay on the table', () => {
    const points = scatterPoints(100, 1920, 1080);
    expect(points).toHaveLength(200);
    for (let i = 0; i < points.length; i += 2) {
      expect(points[i]).toBeGreaterThanOrEqual(0);
      expect(points[i]).toBeLessThan(1920);
      expect(points[i + 1]).toBeLessThan(1080);
    }
  });

  test('orbits are drawn through their planets, as one stroke', () => {
    const system = createSolarSystem(300, 400);
    for (const planet of system.planets) planet.theta = 1.1;
    const { ctx, ellipses, arcs } = recordingContext();

    drawSolarSystem(ctx, system);

    const orbits = ellipses.filter((e) => e.stroke === 0);
    expect(orbits).toHaveLength(system.planets.length);
    system.planets.forEach((planet, i) => {
      const orbit = orbits[i];
      const { x, y } = planetOffset(planet);
      expect(orbit).toBeDefined();
      expect((x / (orbit?.rx ?? 1)) ** 2 + (y / (orbit?.ry ?? 1)) ** 2).toBeCloseTo(1, 10);
      // The planet body is drawn at that offset.
      expect(arcs.some((a) => a.x === x && a.y === y)).toBe(true);
    });
  });

  test('solar systems follow ball indices', () => {
    const systems: (SolarSystem | null)[] = [];
    syncSolarSystems(systems, [ball(10, 20), ball(30, 40)]);
    const first = systems[0];
    expect(first?.sunX).toBe(10);
    expect(systems[1]?.sunY).toBe(40);

    syncSolarSystems(systems, [ball(15, 25)]);
    expect(systems[0]).toBe(first);
    expect(first?.sunX).toBe(15);
    expect(systems[1]).toBeNull();
  });
});
