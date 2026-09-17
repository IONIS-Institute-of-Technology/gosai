/**
 * Interactive Pool main experience.
 *
 * Draws every layer of the app on one fullscreen canvas in the 1920x1080
 * reference space, warped onto the table when the app is calibrated:
 *
 *   - The ball and hand_pose subscriptions keep {@link Tracking} current, and
 *     every layer reads it from the frame.
 *   - Overlays always run: balls, hand skeletons, the gesture menu, the
 *     setup text and the headless live relay.
 *   - The menu starts one scene at a time: rabbits, affine, triangles,
 *     univers or ambient display. Scenes are exclusive, so starting one stops
 *     the other.
 *
 * Z-order, bottom to top: scene, balls, hands, menu, setup text.
 */

import {
  LayerManager,
  applyQuadWarp,
  clearQuadWarp,
  createFullscreenCanvas,
  defineExperience,
  loadCameraProjectorSurfaceCalibration,
  type CameraProjectorSurfaceCalibration,
  type ExperienceRuntimeContext,
  type FrameInfo,
  type FullscreenCanvas,
} from '@gosai/sdk';
import { OVERLAYS, poolLayerDefinitions } from './pool-layers.js';
import {
  DEFAULT_SETTINGS,
  migrateLegacyRelayUrl,
  readPoolSettings,
  type PoolSettings,
} from './settings.js';
import { configureTrackingDrivers } from './shared/calibration.js';
import {
  REF_HEIGHT,
  REF_WIDTH,
  type PoolFrame,
  type PoolLayerDefinition,
  type Tracking,
} from './shared/types.js';
import { createTracking, parseBalls, parseFps, parseHands } from './tracking.js';

interface State {
  readonly tracking: Tracking;
  settings: PoolSettings;
  canvas: FullscreenCanvas | null;
  layers: LayerManager<PoolFrame, PoolLayerDefinition> | null;
}

export default defineExperience<State>({
  init: () => ({
    tracking: createTracking(),
    settings: DEFAULT_SETTINGS,
    canvas: null,
    layers: null,
  }),

  async start(rt, state): Promise<void> {
    const canvas = createFullscreenCanvas({
      reference: { width: REF_WIDTH, height: REF_HEIGHT },
      // The warp below maps the whole canvas onto the table, so fill it.
      mode: 'stretch',
      signal: rt.signal,
    });
    state.canvas = canvas;

    const calibration = await loadCameraProjectorSurfaceCalibration(rt).catch((err: unknown) => {
      rt.log.warn('interactive-pool: could not load the calibration', { err: String(err) });
      return null;
    });
    if (calibration) {
      // Doesn't block the start; failures are logged per driver action.
      void configureTrackingDrivers(rt, calibration, { width: REF_WIDTH, height: REF_HEIGHT });
      warpOntoSurface(rt, canvas, calibration);
    } else {
      rt.log.info('interactive-pool: not calibrated, running uncorrected');
    }

    subscribeTracking(rt, state.tracking);

    await migrateLegacyRelayUrl(rt).catch((err: unknown) =>
      rt.log.warn('interactive-pool: could not move live_server_url', { err: String(err) }),
    );
    rt.settings.onChange((values) => {
      state.settings = readPoolSettings(values);
    });
    state.settings = readPoolSettings(
      await rt.settings.get().catch((err: unknown) => {
        rt.log.warn('interactive-pool: could not read the settings', { err: String(err) });
        return {};
      }),
    );

    const layers: LayerManager<PoolFrame, PoolLayerDefinition> = new LayerManager(
      poolLayerDefinitions(
        rt,
        () => state.settings,
        () => layers,
      ),
      {
        onError: (slug, err, phase) =>
          rt.log.error(`interactive-pool: layer ${slug} failed in ${phase}`, {
            err: err instanceof Error ? (err.stack ?? err.message) : String(err),
          }),
      },
    );
    state.layers = layers;
    await Promise.all(OVERLAYS.map((slug) => layers.start(slug)));
  },

  render(_rt, state, frame: FrameInfo): void {
    const { canvas, layers } = state;
    if (!canvas || !layers) return;
    canvas.fit();
    canvas.ctx.fillStyle = '#000000';
    canvas.ctx.fillRect(0, 0, REF_WIDTH, REF_HEIGHT);
    layers.render({ ...frame, ctx: canvas.ctx, tracking: state.tracking });
  },

  async stop(_rt, state): Promise<void> {
    await state.layers?.stopAll();
    state.layers = null;
    if (state.canvas) {
      clearQuadWarp(state.canvas.canvas);
      state.canvas.remove();
      state.canvas = null;
    }
  },
});

/**
 * Warps the canvas onto the table corners the calibration found on the
 * display, so the rectangular reference space lands on the physical surface
 * whatever the projector angle.
 */
function warpOntoSurface(
  rt: ExperienceRuntimeContext,
  canvas: FullscreenCanvas,
  calibration: CameraProjectorSurfaceCalibration,
): void {
  const quad = calibration.surfaceQuadDisplay;
  if (!quad) return;
  try {
    applyQuadWarp(canvas.canvas, quad);
  } catch (err) {
    clearQuadWarp(canvas.canvas);
    rt.log.warn('interactive-pool: the calibrated table corners are degenerate, not warping', {
      err: String(err),
    });
  }
}

/** Keeps `tracking` current from the ball and hand_pose drivers. */
function subscribeTracking(rt: ExperienceRuntimeContext, tracking: Tracking): void {
  rt.drivers.on('ball', 'balls', (payload) => {
    const balls = parseBalls(payload);
    if (!balls) return;
    tracking.balls = balls;
    tracking.ballsUpdatedAt = performance.now();
  });
  rt.drivers.on('ball', 'fps', (payload) => {
    tracking.ballFps = parseFps(payload) ?? tracking.ballFps;
  });
  rt.drivers.on('hand_pose', 'raw_data', (payload) => {
    tracking.hands = parseHands(payload);
  });
}
