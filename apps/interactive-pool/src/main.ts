/**
 * Interactive Pool main experience.
 *
 * Acts as the orchestrator/compositor for every layer in the app:
 *
 *   - Subscribes once to every driver the layers consume (`ball`,
 *     `hand_pose`) and mirrors the latest payloads into a shared
 *     {@link PoolFeed}.
 *   - Maintains the always-on visual layers (balls, hand skeleton, menu)
 *     and at most one menu-launchable layer (rabbits, affine,
 *     triangles, univers, ambient).
 *   - Drives the per-frame render loop in z-order:
 *
 *       1. Solid black background
 *       2. Active menu-launchable layer (if any)
 *       3. Ball circles
 *       4. Hand skeletons
 *       5. Gesture menu (always last so it sits on top)
 *       6. Title + FPS read-out
 *
 *   - Exposes a {@link MenuController} to the menu layer so it can toggle
 *     menu-launchable layers without knowing about their implementations.
 *   - Runs the headless `live` layer so ball positions are relayed to an
 *     external server when configured.
 */

import {
  defineExperience,
  type ExperienceRuntimeContext,
  type FrameInfo,
  type DriverSubscription,
  type Point2D,
} from '@gosai/sdk';
import {
  applyKeystoneTransform,
  applyReferenceTransform,
  clearKeystoneTransform,
  createCompositorCanvas,
  drawText,
  fitCanvas,
} from './shared/canvas-utils.js';
import { REF_HEIGHT, REF_WIDTH, type FrameContext, type Layer } from './shared/types.js';
import {
  loadCalibration,
  configureBallDriver,
  configureHandPoseDriver,
  type CalibrationData,
} from './shared/calibration.js';
import { createPoolFeed, type PoolFeed } from './shared/feed.js';
import type { MenuController, MenuItem } from './shared/controller.js';

import { createBallsLayer } from './layers/balls.js';
import { createShowHandsLayer } from './layers/show-hands.js';
import { createMenuLayer } from './layers/menu.js';
import { createRabbitsLayer } from './layers/rabbits-game.js';
import { createAffineLayer } from './layers/affine.js';
import { createTrianglesLayer } from './layers/triangles.js';
import { createUniversLayer } from './layers/univers.js';
import { createAmbientDisplayLayer } from './layers/ambient-display.js';
import { createLiveLayer } from './layers/live.js';

interface State {
  container: HTMLElement;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;

  /** Calibration snapshot loaded from this app's storage. */
  calibration: CalibrationData | null;

  feed: PoolFeed;
  subs: DriverSubscription[];

  /** Always-on layers (drawn in this order on top of the active layer). */
  ballsLayer: Layer;
  handsLayer: Layer;
  menuLayer: Layer;
  /** Headless: relays ball data to external server when configured. */
  liveLayer: Layer;

  /** Map of slug -> menu-launchable layer. */
  launchable: Map<string, Layer>;
  /** Ordered list of menu items. */
  menuItems: MenuItem[];
  /** Currently active menu-launchable layer slug, if any. */
  activeSlug: string | null;
  /** Active layer instance, kept in sync with `activeSlug`. */
  activeLayer: Layer | null;
  /** Time `activeLayer.start()` finished -- used to gate `render`. */
  activeReady: boolean;

  /** Render-loop FPS rolling average (ball-driver fps lives on `feed.balls.fps`). */
  renderFps: number;
  fpsAccum: number;
  fpsFrames: number;
  fpsLastReport: number;
}

const MENU_ITEMS: readonly MenuItem[] = [
  { slug: 'rabbits_game', label: 'Rabbits\nGame' },
  { slug: 'affine', label: 'Affine' },
  { slug: 'triangles', label: 'Triangles' },
  { slug: 'univers', label: 'Univers' },
  { slug: 'ambient_display', label: 'Ambient\nDisplay' },
];

export default defineExperience<State>({
  slug: 'main',
  name: 'Interactive Pool',
  description:
    'Composited interactive-pool experience (balls + hands + menu + launchable layers + live relay).',

  init(): State {
    const { container, canvas, ctx } = createCompositorCanvas();
    const feed = createPoolFeed();

    const state: State = {
      container,
      canvas,
      ctx,
      calibration: null,
      feed,
      subs: [],
      ballsLayer: createBallsLayer(feed),
      handsLayer: createShowHandsLayer(feed),
      // The menu layer needs a MenuController; we install it after the
      // state object exists so the controller can close over `state`.
      menuLayer: { render: () => undefined },
      liveLayer: { render: () => undefined },
      launchable: new Map(),
      menuItems: [...MENU_ITEMS],
      activeSlug: null,
      activeLayer: null,
      activeReady: false,
      renderFps: 0,
      fpsAccum: 0,
      fpsFrames: 0,
      fpsLastReport: 0,
    };

    return state;
  },

  async start(rt: ExperienceRuntimeContext, state: State): Promise<void> {
    rt.log.info('interactive-pool: starting compositor');

    // Fetch the calibration snapshot up front so we can both (a) push the
    // homography into the tracking drivers and (b) compute the CSS keystone
    // transform that warps the canvas to the physical surface. We do this in
    // parallel with the rest of start() to avoid blocking driver wiring.
    state.calibration = await loadCalibration(rt).catch((err) => {
      rt.log.warn('interactive-pool: failed to load calibration data', {
        err: String(err),
      });
      return null;
    });

    if (state.calibration) {
      rt.log.info('interactive-pool: calibration loaded', {
        hasSurfaceHomography: !!state.calibration.homographySurface,
        hasSurfaceQuadDisplay: !!state.calibration.surfaceQuadDisplay,
        frameSize: state.calibration.frameSize,
        surfaceSize: state.calibration.surfaceSize,
      });
      // Push the surface homography into ball + hand_pose so their outputs
      // arrive already in our 1920x1080 reference space. Wrap in best-effort
      // try/catch so a missing/old driver does not crash the experience.
      void configureBallDriver(rt, state.calibration, {
        width: REF_WIDTH,
        height: REF_HEIGHT,
      }).catch((err) => rt.log.warn('configureBallDriver failed', { err: String(err) }));
      void configureHandPoseDriver(rt, state.calibration, {
        width: REF_WIDTH,
        height: REF_HEIGHT,
      }).catch((err) => rt.log.warn('configureHandPoseDriver failed', { err: String(err) }));
      // Apply CSS matrix3d keystone correction so the rendered canvas lands on
      // the physical surface exactly, regardless of projector or camera angle.
      applyKeystone(state, state.calibration.surfaceQuadDisplay);
    } else {
      rt.log.info('interactive-pool: no calibration data found, running uncorrected');
    }

    // Build the menu controller now that `state` exists.
    const controller: MenuController = {
      items: state.menuItems,
      active: () => state.activeSlug,
      setActive: (slug: string | null) => {
        void switchActive(state, slug);
      },
    };
    state.menuLayer = createMenuLayer(state.feed, controller);

    // Live relay (headless layer; ignores rendering and just streams).
    state.liveLayer = createLiveLayer(state.feed, rt);

    // Construct each menu-launchable layer once -- they keep their internal
    // state across activations because the compositor calls start()/stop()
    // to reset them.
    state.launchable.set('rabbits_game', createRabbitsLayer(state.feed));
    state.launchable.set('affine', createAffineLayer(state.feed));
    state.launchable.set('triangles', createTrianglesLayer(state.feed));
    state.launchable.set('univers', createUniversLayer(state.feed));
    state.launchable.set('ambient_display', createAmbientDisplayLayer(state.feed));

    // Driver subscriptions feed `state.feed` in place.
    wireDrivers(state, rt);

    // Always-on layers: start each.
    state.ballsLayer.start?.();
    state.handsLayer.start?.();
    state.menuLayer.start?.();
    await state.liveLayer.start?.();
  },

  render(_rt: ExperienceRuntimeContext, state: State, frame: FrameInfo): void {
    fitCanvas(state.canvas);

    const now = frame.timestamp;
    const deltaMs = frame.deltaMs > 0 ? frame.deltaMs : 16.6;

    updateRenderFps(state, now, deltaMs);

    // 1. Background.
    state.ctx.setTransform(1, 0, 0, 1, 0, 0);
    state.ctx.fillStyle = '#000000';
    state.ctx.fillRect(0, 0, state.canvas.width, state.canvas.height);

    // Switch into reference-space coords for all subsequent drawing.
    applyReferenceTransform(state.ctx);

    const frameCtx: FrameContext = {
      ctx: state.ctx,
      refWidth: REF_WIDTH,
      refHeight: REF_HEIGHT,
      timestamp: now,
      deltaMs,
      frameCount: frame.frameCount,
    };

    // 2. Active launchable layer (if ready).
    if (state.activeLayer !== null && state.activeReady) {
      safeRender(state.activeLayer, frameCtx);
    }

    // 3-5. Overlays in order.
    safeRender(state.ballsLayer, frameCtx);
    safeRender(state.handsLayer, frameCtx);

    // 6. Menu (always on top).
    safeRender(state.menuLayer, frameCtx);

    // 7. Title + render-FPS read-out (legacy bottom-of-screen bar).
    drawTitleBar(state);

    // Headless live layer (post-paint to maximise data freshness).
    safeRender(state.liveLayer, frameCtx);
  },

  async stop(rt: ExperienceRuntimeContext, state: State): Promise<void> {
    rt.log.info('interactive-pool: stopping compositor');
    for (const sub of state.subs) {
      try {
        sub.unsubscribe();
      } catch {
        // best-effort.
      }
    }
    state.subs.length = 0;
    state.activeLayer?.stop?.();
    state.activeLayer = null;
    state.activeSlug = null;
    state.activeReady = false;
    for (const layer of state.launchable.values()) {
      try {
        layer.stop?.();
      } catch {
        // best-effort.
      }
    }
    state.menuLayer.stop?.();
    state.handsLayer.stop?.();
    state.ballsLayer.stop?.();
    state.liveLayer.stop?.();
    clearKeystoneTransform(state.canvas);
    state.container.remove();
  },
});

function applyKeystone(state: State, quad: readonly Point2D[] | null): void {
  if (!quad || quad.length !== 4) {
    clearKeystoneTransform(state.canvas);
    return;
  }
  try {
    applyKeystoneTransform(state.canvas, [quad[0]!, quad[1]!, quad[2]!, quad[3]!]);
  } catch {
    // Degenerate quad (e.g. coincident corners) -- skip keystone correction.
    clearKeystoneTransform(state.canvas);
  }
}

// ---------------------------------------------------------------------------
// Driver wiring
// ---------------------------------------------------------------------------

function wireDrivers(state: State, rt: ExperienceRuntimeContext): void {
  // Balls: the Python ball driver emits `{ balls: [{x, y, r, vx, vy}, ...], count, ts }`
  // and `{ fps: number }`.
  state.subs.push(
    rt.drivers.on('ball', 'balls', (data) => {
      const incoming = parseBalls(data);
      if (!incoming) return;
      state.feed.balls.balls = incoming;
      state.feed.balls.lastUpdate = performance.now();
    }),
  );
  state.subs.push(
    rt.drivers.on('ball', 'fps', (data) => {
      const v = parseFps(data);
      if (v !== null) state.feed.balls.fps = v;
    }),
  );

  // Hands.
  state.subs.push(
    rt.drivers.on('hand_pose', 'raw_data', (data) => {
      if (typeof data !== 'object' || data === null) return;
      const payload = data as {
        hands_landmarks?: number[][][];
        hands_handedness?: Array<[unknown, unknown, unknown]>;
      };
      state.feed.hands.hands = payload.hands_landmarks ?? [];
      state.feed.hands.handedness = payload.hands_handedness ?? [];
      state.feed.hands.lastUpdate = performance.now();
    }),
  );
}

type ParsedBall = { x: number; y: number; r: number; vx: number; vy: number };

function parseBalls(data: unknown): ParsedBall[] | null {
  if (data === null || data === undefined) return null;
  if (typeof data === 'object' && !Array.isArray(data)) {
    const wrapped = data as { balls?: unknown };
    if (Array.isArray(wrapped.balls)) {
      return wrapped.balls
        .map((entry) => coerceBall(entry))
        .filter((b): b is ParsedBall => b !== null);
    }
  }
  return null;
}

function coerceBall(entry: unknown): ParsedBall | null {
  if (entry !== null && typeof entry === 'object') {
    const obj = entry as {
      x?: unknown;
      y?: unknown;
      r?: unknown;
      vx?: unknown;
      vy?: unknown;
    };
    const x = Number(obj.x);
    const y = Number(obj.y);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      const r = Number(obj.r);
      const vx = Number(obj.vx);
      const vy = Number(obj.vy);
      return {
        x,
        y,
        r: Number.isFinite(r) && r > 0 ? r : 80,
        vx: Number.isFinite(vx) ? vx : 0,
        vy: Number.isFinite(vy) ? vy : 0,
      };
    }
  }
  return null;
}

function parseFps(data: unknown): number | null {
  if (typeof data === 'number' && Number.isFinite(data)) return data;
  if (typeof data === 'object' && data !== null) {
    const obj = data as { fps?: unknown };
    const v = Number(obj.fps);
    if (Number.isFinite(v)) return v;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Active layer toggling
// ---------------------------------------------------------------------------

async function switchActive(state: State, slug: string | null): Promise<void> {
  if (slug === state.activeSlug) return;

  // Stop the current active layer.
  if (state.activeLayer !== null) {
    try {
      state.activeLayer.stop?.();
    } catch {
      // best-effort.
    }
    state.activeLayer = null;
    state.activeSlug = null;
    state.activeReady = false;
  }

  if (slug === null) return;
  const layer = state.launchable.get(slug);
  if (!layer) return;

  state.activeLayer = layer;
  state.activeSlug = slug;
  state.activeReady = false;
  try {
    await layer.start?.();
    state.activeReady = true;
  } catch {
    state.activeLayer = null;
    state.activeSlug = null;
    state.activeReady = false;
  }
}

// ---------------------------------------------------------------------------
// Render helpers
// ---------------------------------------------------------------------------

function safeRender(layer: Layer, frame: FrameContext): void {
  try {
    layer.render(frame);
  } catch (err) {
    // Never let one layer take down the whole compositor; surface via
    // console for dev visibility.
    // eslint-disable-next-line no-console
    console.error('interactive-pool: layer render threw', err);
  }
}

function updateRenderFps(state: State, now: number, deltaMs: number): void {
  state.fpsAccum += deltaMs;
  state.fpsFrames += 1;
  if (now - state.fpsLastReport > 500) {
    state.renderFps = (state.fpsFrames * 1000) / Math.max(1, state.fpsAccum);
    state.fpsAccum = 0;
    state.fpsFrames = 0;
    state.fpsLastReport = now;
  }
}

function drawTitleBar(state: State): void {
  // Title is anchored at the bottom of the reference space, rotated 180
  // degrees to match projector orientation.
  state.ctx.save();
  state.ctx.translate(REF_WIDTH / 2, REF_HEIGHT - 30);
  state.ctx.rotate(Math.PI);
  state.ctx.fillStyle = '#ffffff';
  state.ctx.font = 'bold 36px ui-monospace, monospace';
  state.ctx.textAlign = 'center';
  state.ctx.textBaseline = 'middle';
  state.ctx.fillText('INTERACTIVE POOL PROJECT', 0, 0);
  state.ctx.restore();

  // Render FPS in the un-rotated top-left corner (development read-out).
  drawText(state.ctx, `render ${state.renderFps.toFixed(0)} fps`, 24, 36, 24, '#9ca3af');
}
