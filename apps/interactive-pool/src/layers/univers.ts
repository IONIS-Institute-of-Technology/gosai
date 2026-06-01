/**
 * Univers visualization.
 *
 * - Background: 2000 dim-blue dots scattered across the table.
 * - Galaxy: 4000 stars distributed on an Archimedean spiral, slowly rotating.
 * - Per ball (max 6): a solar system with a glowing sun and 8 orbiting
 *   planets, some of which carry rings.
 *
 * Solar systems are kept in sync with ball indices so planet orbits persist
 * between frames as long as the same ball stays detected.
 */

import { REF_HEIGHT, REF_WIDTH, type FrameContext, type Layer } from '../shared/types.js';
import { fillCircle } from '../shared/canvas-utils.js';
import { rand } from '../shared/math.js';
import type { PoolFeed } from '../shared/feed.js';

const BACKGROUND_DOTS = 2000;
const GALAXY_STARS = 4000;
const MAX_SOLAR_SYSTEMS = 6;
const PLANET_COUNT = 8;

const SOLAR_TAB_COLORS: ReadonlyArray<readonly [number, number, number]> = [
  [128, 128, 128],
  [250, 240, 180],
  [0, 127, 255],
  [178, 46, 32],
  [255, 175, 0],
  [255, 255, 0],
  [147, 184, 190],
  [75, 112, 221],
];

interface Star {
  radiusW: number;
  radiusH: number;
  theta: number;
  velocity: number;
  /** Spiral seed angle: legacy uses `(PI/nbStars)*i` as the per-star frame
   *  rotation, which we apply once to position each star on the spiral. */
  spiral: number;
}

interface Dot {
  x: number;
  y: number;
}

interface Planet {
  /** Orbit ellipse radius (x). */
  radiusW: number;
  /** Orbit ellipse radius (y). */
  radiusH: number;
  /** Planet radius. */
  r: number;
  /** Angular speed in radians/frame. */
  velocity: number;
  /** Current orbit angle. */
  theta: number;
  color: readonly [number, number, number];
  /** Whether this planet renders a ring (legacy: planets 2, 4, 6 when
   *  `anneau` random flag is on). */
  hasRing: boolean;
}

interface SolarSystem {
  sunX: number;
  sunY: number;
  /** Tilt of the whole solar system about the sun. */
  tilt: number;
  /** Sun radius. */
  sunR: number;
  /** Sun colour. */
  sunColor: readonly [number, number, number];
  planets: Planet[];
}

export function createUniversLayer(feed: PoolFeed): Layer {
  let dots: Dot[] = [];
  let stars: Star[] = [];
  const systems: (SolarSystem | null)[] = new Array(MAX_SOLAR_SYSTEMS).fill(null);
  const prevPositions: Array<{ x: number; y: number } | null> = new Array(MAX_SOLAR_SYSTEMS).fill(
    null,
  );

  function init(): void {
    dots = [];
    for (let i = 0; i < BACKGROUND_DOTS; i++) {
      dots.push({ x: rand(0, REF_WIDTH), y: rand(0, REF_HEIGHT) });
    }
    stars = [];
    for (let i = 0; i < GALAXY_STARS; i++) {
      const radiusW = 5 + i * 0.2;
      const radiusH = radiusW / 2;
      stars.push({
        radiusW,
        radiusH,
        theta: rand(0, 2 * Math.PI),
        velocity: 0.0015,
        spiral: (Math.PI / GALAXY_STARS) * i,
      });
    }
    for (let i = 0; i < systems.length; i++) {
      systems[i] = null;
      prevPositions[i] = null;
    }
  }

  function makeSolarSystem(x: number, y: number): SolarSystem {
    const ringFlag = Math.random() < 0.5;
    const planets: Planet[] = [];
    for (let i = 1; i <= PLANET_COUNT; i++) {
      const colorIdx = i - 1;
      const c = SOLAR_TAB_COLORS[colorIdx] ?? SOLAR_TAB_COLORS[0]!;
      planets.push({
        radiusW: 100 + (i - 1) * 50,
        radiusH: 25 + (i - 1) * 12,
        r: rand(10, 40),
        velocity: 0.01 - (i - 1) * 0.001,
        theta: rand(0, 2 * Math.PI),
        color: c,
        hasRing: ringFlag && (i === 2 || i === 4 || i === 6),
      });
    }
    return {
      sunX: x,
      sunY: y,
      tilt: -Math.PI / 12,
      sunR: 100,
      sunColor: [255, 140, 0],
      planets,
    };
  }

  return {
    start(): void {
      init();
    },

    render(frame: FrameContext): void {
      const { ctx } = frame;

      // Background.
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, REF_WIDTH, REF_HEIGHT);

      // Background dots.
      ctx.fillStyle = 'rgba(30,144,255,0.63)';
      for (const dot of dots) {
        ctx.beginPath();
        ctx.arc(dot.x, dot.y, 1, 0, Math.PI * 2);
        ctx.fill();
      }

      // Galaxy: each star occupies its own spiral seat and slowly orbits.
      ctx.save();
      ctx.translate(REF_WIDTH / 2, REF_HEIGHT / 2);
      for (const star of stars) {
        star.theta += star.velocity;
        ctx.save();
        ctx.rotate(star.spiral);
        const x = (star.radiusW / 2) * Math.cos(star.theta);
        const y = (star.radiusH / 2) * Math.sin(star.theta);
        ctx.fillStyle = 'rgba(221,160,221,0.49)';
        ctx.beginPath();
        ctx.arc(x, y, 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
      ctx.restore();

      // Sync solar systems with current ball indices.
      const balls = feed.balls.balls;
      for (let i = 0; i < MAX_SOLAR_SYSTEMS; i++) {
        const ball = balls[i];
        if (!ball) {
          systems[i] = null;
          prevPositions[i] = null;
          continue;
        }
        const prev = prevPositions[i];
        if (!prev) {
          systems[i] = makeSolarSystem(ball.x, ball.y);
        } else if (Math.hypot(prev.x - ball.x, prev.y - ball.y) > 1) {
          const sys = systems[i];
          if (sys) {
            sys.sunX = ball.x;
            sys.sunY = ball.y;
          }
        }
        prevPositions[i] = { x: ball.x, y: ball.y };
      }

      for (const sys of systems) {
        if (sys) drawSolarSystem(ctx, sys);
      }
    },

    stop(): void {
      dots = [];
      stars = [];
      for (let i = 0; i < systems.length; i++) {
        systems[i] = null;
        prevPositions[i] = null;
      }
    },
  };
}

function drawSolarSystem(ctx: CanvasRenderingContext2D, sys: SolarSystem): void {
  ctx.save();
  ctx.translate(sys.sunX, sys.sunY);
  ctx.rotate(sys.tilt);

  // Sun.
  fillCircle(ctx, 0, 0, sys.sunR, `rgb(${sys.sunColor[0]},${sys.sunColor[1]},${sys.sunColor[2]})`);

  for (const planet of sys.planets) {
    planet.theta += planet.velocity;
    const px = planet.radiusW * Math.cos(planet.theta);
    const py = planet.radiusH * Math.sin(planet.theta);

    // Orbit trace.
    ctx.strokeStyle = 'rgba(255,255,255,0.39)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.ellipse(0, 0, planet.radiusW / 2, planet.radiusH / 2, 0, 0, Math.PI * 2);
    ctx.stroke();

    // Ring (if present).
    if (planet.hasRing) {
      ctx.strokeStyle = '#ffffff';
      ctx.beginPath();
      ctx.ellipse(px, py, (2.5 * planet.r) / 2, planet.r / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Planet body.
    ctx.fillStyle = `rgb(${planet.color[0]},${planet.color[1]},${planet.color[2]})`;
    ctx.beginPath();
    ctx.arc(px, py, planet.r / 2, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}
