/**
 * Univers visualization.
 *
 * - Background: 2000 dim-blue dots scattered across the table.
 * - Galaxy: 4000 stars on an Archimedean spiral, slowly rotating.
 * - Per ball (max 6): a solar system with a sun and 8 orbiting planets,
 *   some of which carry rings.
 *
 * Positions that don't change are computed once at start, and same-coloured
 * shapes are drawn in a few paths, so a frame costs a few dozen fills instead
 * of thousands. Solar systems follow ball indices, so planet
 * orbits persist between frames as long as the same ball stays detected.
 */

import { fillCircle } from '../shared/draw.js';
import { rand } from '../shared/math.js';
import { frameSteps } from '../shared/motion.js';
import {
  REF_HEIGHT,
  REF_WIDTH,
  type Ball,
  type PoolFrame,
  type PoolLayer,
} from '../shared/types.js';

const BACKGROUND_DOTS = 2000;
const GALAXY_STARS = 4000;
const MAX_SOLAR_SYSTEMS = 6;
/** Galaxy rotation, in radians per legacy frame. */
const GALAXY_VELOCITY = 0.0015;

const DOT_COLOR = 'rgba(30,144,255,0.63)';
/** See {@link drawGalaxy} for why this isn't the legacy 0.49. */
const STAR_COLOR = 'rgba(221,160,221,0.51)';
const STAR_BATCHES = 8;
const ORBIT_COLOR = 'rgba(255,255,255,0.39)';
const SUN_COLOR = 'rgb(255,140,0)';
const SUN_DIAMETER = 100;
const SYSTEM_TILT = -Math.PI / 12;

/** One colour per planet, innermost first. */
const PLANET_COLORS: readonly string[] = [
  'rgb(128,128,128)',
  'rgb(250,240,180)',
  'rgb(0,127,255)',
  'rgb(178,46,32)',
  'rgb(255,175,0)',
  'rgb(255,255,0)',
  'rgb(147,184,190)',
  'rgb(75,112,221)',
];

/**
 * Stars as parallel arrays. Star `i` sits on an ellipse with semi-axes
 * `a[i]`, `b[i]`, turned by its spiral angle, at orbit angle `phase[i]` plus
 * the galaxy's rotation.
 */
export interface Galaxy {
  readonly a: Float64Array;
  readonly b: Float64Array;
  readonly cos: Float64Array;
  readonly sin: Float64Array;
  readonly phase: Float64Array;
}

export interface Planet {
  /** Orbit ellipse semi-axes. */
  readonly radiusW: number;
  readonly radiusH: number;
  /** Planet diameter. */
  readonly r: number;
  /** Angular speed in radians per legacy frame. */
  readonly velocity: number;
  /** Current orbit angle. */
  theta: number;
  readonly color: string;
  readonly hasRing: boolean;
}

export interface SolarSystem {
  sunX: number;
  sunY: number;
  readonly planets: readonly Planet[];
}

export function createUniversLayer(): PoolLayer {
  let dots: Float64Array = new Float64Array(0);
  let galaxy = createGalaxy(0);
  let galaxyAngle = 0;
  const systems: (SolarSystem | null)[] = [];

  return {
    start(): void {
      dots = scatterPoints(BACKGROUND_DOTS, REF_WIDTH, REF_HEIGHT);
      galaxy = createGalaxy(GALAXY_STARS);
      galaxyAngle = 0;
      systems.length = 0;
    },

    render({ ctx, deltaMs, tracking }: PoolFrame): void {
      const steps = frameSteps(deltaMs);
      galaxyAngle += GALAXY_VELOCITY * steps;

      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, REF_WIDTH, REF_HEIGHT);

      ctx.fillStyle = DOT_COLOR;
      ctx.beginPath();
      for (let i = 0; i < dots.length; i += 2) addDot(ctx, dots[i] ?? 0, dots[i + 1] ?? 0, 1);
      ctx.fill();

      drawGalaxy(ctx, galaxy, galaxyAngle);

      syncSolarSystems(systems, tracking.balls);
      for (const system of systems) {
        if (!system) continue;
        for (const planet of system.planets) planet.theta += planet.velocity * steps;
        drawSolarSystem(ctx, system);
      }
    },

    stop(): void {
      dots = new Float64Array(0);
      galaxy = createGalaxy(0);
      systems.length = 0;
    },
  };
}

/** `count` random points in a `width` x `height` rectangle, as x, y pairs. */
export function scatterPoints(count: number, width: number, height: number): Float64Array {
  const points = new Float64Array(count * 2);
  for (let i = 0; i < count; i++) {
    points[i * 2] = rand(0, width);
    points[i * 2 + 1] = rand(0, height);
  }
  return points;
}

/**
 * The legacy spiral: star `i` has an orbit of `5 + 0.2 i` by half that,
 * halved again when drawn, turned by `i * PI / count`.
 */
export function createGalaxy(count: number): Galaxy {
  const galaxy: Galaxy = {
    a: new Float64Array(count),
    b: new Float64Array(count),
    cos: new Float64Array(count),
    sin: new Float64Array(count),
    phase: new Float64Array(count),
  };
  for (let i = 0; i < count; i++) {
    const radiusW = 5 + i * 0.2;
    const spiral = (Math.PI / count) * i;
    galaxy.a[i] = radiusW / 2;
    galaxy.b[i] = radiusW / 4;
    galaxy.cos[i] = Math.cos(spiral);
    galaxy.sin[i] = Math.sin(spiral);
    galaxy.phase[i] = rand(0, 2 * Math.PI);
  }
  return galaxy;
}

/** Offset of star `i` from the galaxy centre once the galaxy turned by `angle`. */
export function starPosition(galaxy: Galaxy, i: number, angle: number): { x: number; y: number } {
  const theta = (galaxy.phase[i] ?? 0) + angle;
  const ex = (galaxy.a[i] ?? 0) * Math.cos(theta);
  const ey = (galaxy.b[i] ?? 0) * Math.sin(theta);
  const cos = galaxy.cos[i] ?? 1;
  const sin = galaxy.sin[i] ?? 0;
  return { x: ex * cos - ey * sin, y: ex * sin + ey * cos };
}

/**
 * Keeps one solar system per ball index: a new ball gets a new system, a
 * known one moves its sun to the ball, and a missing one loses its system.
 */
export function syncSolarSystems(systems: (SolarSystem | null)[], balls: readonly Ball[]): void {
  for (let i = 0; i < MAX_SOLAR_SYSTEMS; i++) {
    const ball = balls[i];
    const system = systems[i];
    if (!ball) {
      systems[i] = null;
    } else if (system) {
      system.sunX = ball.x;
      system.sunY = ball.y;
    } else {
      systems[i] = createSolarSystem(ball.x, ball.y);
    }
  }
}

export function createSolarSystem(x: number, y: number): SolarSystem {
  const ringed = Math.random() < 0.5;
  const planets = PLANET_COLORS.map((color, i): Planet => ({
    radiusW: 100 + i * 50,
    radiusH: 25 + i * 12,
    r: rand(10, 40),
    velocity: 0.01 - i * 0.001,
    theta: rand(0, 2 * Math.PI),
    color,
    // Legacy: planets 2, 4 and 6 carry rings when the system is ringed.
    hasRing: ringed && i % 2 === 1 && i < 6,
  }));
  return { sunX: x, sunY: y, planets };
}

/**
 * Draws the stars in {@link STAR_BATCHES} fills. Overlapping circles in one
 * path cover a pixel once, while the legacy code filled each star on its own
 * and overlaps added up. Interleaved batches restore most of that glow in the
 * dense core, and {@link STAR_COLOR} is a little more opaque than the legacy
 * 0.49 to make up the rest: measured against the legacy drawing, a frame and
 * its core come out within 1% of the old brightness.
 */
export function drawGalaxy(ctx: CanvasRenderingContext2D, galaxy: Galaxy, angle: number): void {
  const cx = REF_WIDTH / 2;
  const cy = REF_HEIGHT / 2;
  ctx.fillStyle = STAR_COLOR;
  for (let batch = 0; batch < STAR_BATCHES; batch++) {
    ctx.beginPath();
    for (let i = batch; i < galaxy.a.length; i += STAR_BATCHES) {
      const { x, y } = starPosition(galaxy, i, angle);
      addDot(ctx, cx + x, cy + y, 2);
    }
    ctx.fill();
  }
}

/** Where a planet sits relative to its sun, before the system's tilt. */
export function planetOffset(planet: Planet): { x: number; y: number } {
  return { x: planet.radiusW * Math.cos(planet.theta), y: planet.radiusH * Math.sin(planet.theta) };
}

export function drawSolarSystem(ctx: CanvasRenderingContext2D, system: SolarSystem): void {
  ctx.save();
  ctx.translate(system.sunX, system.sunY);
  ctx.rotate(SYSTEM_TILT);

  fillCircle(ctx, 0, 0, SUN_DIAMETER, SUN_COLOR);

  // Orbits and rings, each as one path.
  ctx.lineWidth = 1;
  ctx.strokeStyle = ORBIT_COLOR;
  ctx.beginPath();
  for (const planet of system.planets) {
    ctx.moveTo(planet.radiusW, 0);
    ctx.ellipse(0, 0, planet.radiusW, planet.radiusH, 0, 0, Math.PI * 2);
  }
  ctx.stroke();

  ctx.strokeStyle = '#ffffff';
  ctx.beginPath();
  for (const planet of system.planets) {
    if (!planet.hasRing) continue;
    const { x, y } = planetOffset(planet);
    ctx.moveTo(x + (2.5 * planet.r) / 2, y);
    ctx.ellipse(x, y, (2.5 * planet.r) / 2, planet.r / 2, 0, 0, Math.PI * 2);
  }
  ctx.stroke();

  for (const planet of system.planets) {
    const { x, y } = planetOffset(planet);
    fillCircle(ctx, x, y, planet.r, planet.color);
  }

  ctx.restore();
}

/** Adds a circle to the current path without joining it to the previous one. */
function addDot(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number): void {
  ctx.moveTo(x + radius, y);
  ctx.arc(x, y, radius, 0, Math.PI * 2);
}
