/**
 * Second Self main experience (compositor).
 *
 * Acts as the orchestrator for every layer in the app, mirroring the
 * interactive-pool reference architecture:
 *
 *   - Subscribes once to the drivers the layers consume (`pose_to_mirror`,
 *     `frequency_analysis`, `slr`) and mirrors the latest payloads into a shared
 *     {@link MirrorFeed}.
 *   - Configures the `pose_to_mirror` mirror geometry and the `slr` action set
 *     on start.
 *   - Owns a {@link LayerManager} that registers one layer per legacy
 *     experience, enforces exclusivity/allowed/required relationships, manages
 *     per-layer options, and renders running layers in z-order each frame.
 *   - Keeps the persistent overlays (menu, hands, body, face) running and lets
 *     the gesture menu launch the rest.
 *
 * The legacy socket-based `app_manager` and per-app Python `processing.py`
 * processes are replaced by this in-process orchestration; audio synthesis is
 * done in-browser via the shared {@link Synth}.
 */

import {
  defineExperience,
  type DriverSubscription,
  type ExperienceRuntimeContext,
  type FrameInfo,
} from '@gosai/sdk';

import { assetUrl } from './shared/assets.js';
import { applyReferenceTransform, createCompositorCanvas, fitCanvas } from './shared/canvas.js';
import {
  DEFAULT_CONFIG,
  loadConfig,
  loadMirrorProfile,
  toMirrorDriverConfig,
  type SecondSelfConfig,
} from './shared/config.js';
import type { LayerDeps } from './shared/deps.js';
import { createMirrorFeed, type MirrorFeed } from './shared/feed.js';
import { LayerManager, type LayerDef } from './shared/menu-controller.js';
import { SleepController } from './shared/sleep.js';
import { Synth } from './shared/synth.js';
import {
  REF_HEIGHT,
  REF_WIDTH,
  type FrameContext,
  type FrequencyData,
  type MirroredData,
  type RawPoseData,
  type SignData,
} from './shared/types.js';

import { createAriaLayer } from './layers/aria.js';
import { createBodyLayer } from './layers/body.js';
import { createBounceLayer } from './layers/bounce.js';
import { createCalibrateLayer } from './layers/calibrate.js';
import { createClockLayer } from './layers/clock.js';
import { createDanceLayer } from './layers/dance.js';
import { createFaceLayer } from './layers/face.js';
import { createHandsLayer } from './layers/hands.js';
import { createMenuLayer } from './layers/menu.js';
import { createMusicTrainingLayer } from './layers/music-training.js';
import { createPokeItLayer } from './layers/poke-it.js';
import { createShowFrequencyLayer } from './layers/show-frequency.js';
import { createShowPingLayer } from './layers/show-ping.js';
import { createSignGameLayer } from './layers/sign-game.js';
import { createSignTrainingLayer } from './layers/sign-training.js';
import { createTheremineLayer } from './layers/theremine.js';

/** SLR action set (16 signs) shared by sign-game and sign-training. */
const SIGN_ACTIONS = [
  'nothing',
  'empty',
  'ok',
  'yes',
  'no',
  'left',
  'right',
  'house',
  'store',
  'hello',
  'goodbye',
  'television',
  'leave',
  'eat',
  'apple',
  'peach',
];

/** Layers running at startup (persistent overlays + launcher). */
const STARTUP = ['menu', 'hands', 'body', 'face'];

interface State {
  container: HTMLElement;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  feed: MirrorFeed;
  synth: Synth;
  manager: LayerManager;
  subs: DriverSubscription[];
  config: SecondSelfConfig;
  sleep: SleepController | null;
}

export default defineExperience<State>({
  slug: 'main',
  name: 'Second Self',
  description:
    'Composited augmented-mirror experience with a gesture menu and per-experience layers.',

  init(): State {
    const { container, canvas, ctx } = createCompositorCanvas();
    const feed = createMirrorFeed();
    const synth = new Synth();

    // Built later in start() once the runtime context is available.
    const placeholder = new LayerManager([]);

    return {
      container,
      canvas,
      ctx,
      feed,
      synth,
      manager: placeholder,
      subs: [],
      config: DEFAULT_CONFIG,
      sleep: null,
    };
  },

  async start(rt: ExperienceRuntimeContext, state: State): Promise<void> {
    rt.log.info('second-self: starting compositor');

    state.config = await loadConfig(rt);
    const profile = await loadMirrorProfile(rt);
    rt.log.info('second-self: config loaded', {
      mode: state.config.projection.mode,
      calibrated: profile !== null,
    });

    const deps: LayerDeps = {
      feed: state.feed,
      synth: state.synth,
      rt,
      config: state.config,
      assetUrl,
      // Replaced just below with the real manager (layers capture `deps`).
      controller: undefined as unknown as LayerManager,
    };

    state.sleep = new SleepController(state.config.sleep, state.feed);

    const defs = buildLayerDefs(deps);
    state.manager = new LayerManager(defs, (slug, err) => {
      rt.log.warn('second-self: layer error', { slug, err: String(err) });
    });
    deps.controller = state.manager;

    // Configure the mirror projection + SLR action set (best-effort).
    void rt.drivers
      .execute('pose_to_mirror', 'set_mirror_config', toMirrorDriverConfig(state.config, profile))
      .catch((err) => rt.log.warn('set_mirror_config failed', { err: String(err) }));
    void rt.drivers
      .execute('slr', 'set_actions', SIGN_ACTIONS)
      .catch((err) => rt.log.warn('slr set_actions failed', { err: String(err) }));

    wireDrivers(state, rt);

    // Resume audio on the first user gesture (autoplay policy).
    const resumeAudio = (): void => void state.synth.resume();
    window.addEventListener('pointerdown', resumeAudio, { once: true });

    for (const slug of STARTUP) state.manager.start(slug);

    // A reflection rig without a fitted profile cannot align the skeleton to
    // the reflection; walk straight into the calibration wizard.
    if (state.config.projection.mode === 'reflection' && profile === null) {
      rt.log.info('second-self: no mirror calibration profile, starting wizard');
      state.manager.start('calibrate');
    }
  },

  render(_rt: ExperienceRuntimeContext, state: State, frame: FrameInfo): void {
    fitCanvas(state.canvas);

    state.ctx.setTransform(1, 0, 0, 1, 0, 0);
    state.ctx.fillStyle = '#000000';
    state.ctx.fillRect(0, 0, state.canvas.width, state.canvas.height);

    // Fixed portrait reference space, aspect-preserving fit: fills any 9:16
    // screen exactly and letterboxes others without distortion.
    applyReferenceTransform(state.ctx, 'contain', REF_WIDTH, REF_HEIGHT);

    const frameCtx: FrameContext = {
      ctx: state.ctx,
      refWidth: REF_WIDTH,
      refHeight: REF_HEIGHT,
      timestamp: frame.timestamp,
      deltaMs: frame.deltaMs > 0 ? frame.deltaMs : 16.6,
      frameCount: frame.frameCount,
    };

    state.sleep?.update(frameCtx.timestamp, frameCtx.deltaMs);

    // Fully asleep: the canvas is already black-filled, skip all layer work.
    if (state.sleep?.dormant()) return;

    state.manager.render(frameCtx);
    state.sleep?.render(state.ctx, frameCtx.timestamp);
  },

  async stop(rt: ExperienceRuntimeContext, state: State): Promise<void> {
    rt.log.info('second-self: stopping compositor');
    for (const sub of state.subs) {
      try {
        sub.unsubscribe();
      } catch {
        // best-effort.
      }
    }
    state.subs.length = 0;
    state.manager.stopAll();
    state.synth.dispose();
    state.container.remove();
  },
});

// ---------------------------------------------------------------------------
// Layer registry
// ---------------------------------------------------------------------------

function buildLayerDefs(deps: LayerDeps): LayerDef[] {
  return [
    // Persistent overlays + launcher.
    {
      slug: 'menu',
      label: 'Menu',
      icon: 'menu.svg',
      zIndex: 100,
      inMenu: false,
      create: () => createMenuLayer(deps),
    },
    {
      slug: 'hands',
      label: 'Hands',
      icon: 'user.svg',
      zIndex: 60,
      inMenu: true,
      create: () => createHandsLayer(deps),
    },
    {
      slug: 'body',
      label: 'Body',
      icon: 'user.svg',
      zIndex: 50,
      inMenu: true,
      create: () => createBodyLayer(deps),
    },
    {
      slug: 'face',
      label: 'Face',
      icon: 'user.svg',
      zIndex: 55,
      inMenu: true,
      create: () => createFaceLayer(deps),
    },

    // Mirror calibration wizard: reflection rigs only. Exclusive so the
    // (mis)calibrated skeleton overlays don't confuse the capture flow.
    {
      slug: 'calibrate',
      label: 'Calibrate',
      zIndex: 90,
      inMenu: deps.config.projection.mode === 'reflection',
      exclusive: true,
      allowed: ['menu'],
      create: () => createCalibrateLayer(deps),
    },

    // Exclusive experiences (allowed lists ported from legacy processing.py).
    {
      slug: 'clock',
      label: 'Clock',
      zIndex: 40,
      inMenu: true,
      exclusive: true,
      allowed: ['menu', 'face', 'body', 'hands', 'aria', 'bounce', 'poke-it'],
      create: () => createClockLayer(deps),
    },
    {
      slug: 'poke-it',
      label: 'Poke It',
      icon: 'play.svg',
      zIndex: 30,
      inMenu: true,
      exclusive: true,
      allowed: ['menu', 'face', 'body', 'hands', 'aria', 'clock', 'bounce'],
      create: () => createPokeItLayer(deps),
    },
    {
      slug: 'bounce',
      label: 'Bounce',
      icon: 'play.svg',
      zIndex: 31,
      inMenu: true,
      exclusive: true,
      allowed: ['menu', 'face', 'body', 'hands', 'aria', 'clock', 'poke-it'],
      create: () => createBounceLayer(deps),
    },
    {
      slug: 'show-frequency',
      label: 'Frequency',
      icon: 'music_training.svg',
      zIndex: 32,
      inMenu: true,
      create: () => createShowFrequencyLayer(deps),
    },
    {
      slug: 'show-ping',
      label: 'Ping',
      icon: 'info.svg',
      zIndex: 33,
      inMenu: true,
      create: () => createShowPingLayer(deps),
    },
    {
      slug: 'theremine',
      label: 'Theremine',
      icon: 'theremine.svg',
      zIndex: 34,
      inMenu: true,
      exclusive: true,
      allowed: ['menu', 'hands'],
      required: ['menu', 'hands'],
      options: [{ name: 'Sound', type: 'toggle', default: true }],
      create: () => createTheremineLayer(deps),
    },
    {
      slug: 'music-training',
      label: 'Music Training',
      icon: 'music_training.svg',
      zIndex: 35,
      inMenu: true,
      exclusive: true,
      allowed: ['menu', 'hands'],
      required: ['menu', 'hands'],
      options: [
        { name: 'Show bars', type: 'toggle', default: true },
        { name: 'Play La Vie En Rose', type: 'button' },
        { name: 'Stop', type: 'button' },
      ],
      create: () => createMusicTrainingLayer(deps),
    },
    {
      slug: 'dance',
      label: 'Dance',
      icon: 'disco.svg',
      zIndex: 6,
      inMenu: true,
      exclusive: true,
      allowed: ['menu', 'face', 'body', 'hands', 'clock'],
      required: ['menu', 'body'],
      create: () => createDanceLayer(deps),
    },
    {
      slug: 'sign-game',
      label: 'Sign Game',
      icon: 'play.svg',
      zIndex: 7,
      inMenu: true,
      exclusive: true,
      allowed: ['menu', 'hands'],
      required: ['menu', 'hands'],
      create: () => createSignGameLayer(deps),
    },
    {
      slug: 'sign-training',
      label: 'Sign Training',
      icon: 'user.svg',
      zIndex: 8,
      inMenu: true,
      exclusive: true,
      allowed: ['menu', 'face', 'body', 'hands'],
      required: ['menu', 'face', 'body', 'hands'],
      create: () => createSignTrainingLayer(deps),
    },
    {
      slug: 'aria',
      label: 'Aria',
      icon: 'user.svg',
      zIndex: 5,
      inMenu: true,
      exclusive: true,
      allowed: ['menu', 'hands', 'bounce', 'clock', 'poke-it', 'show-ping'],
      create: () => createAriaLayer(deps),
    },
  ];
}

// ---------------------------------------------------------------------------
// Driver wiring
// ---------------------------------------------------------------------------

function wireDrivers(state: State, rt: ExperienceRuntimeContext): void {
  state.subs.push(
    rt.drivers.on('pose_to_mirror', 'mirrored_data', (data) => {
      const parsed = parseMirrored(data);
      if (!parsed) return;
      state.feed.mirror.data = parsed;
      state.feed.mirror.lastUpdate = performance.now();
    }),
  );

  // Raw camera-space landmarks for the aria avatar (Kalidokit needs
  // aspect-correct, unmirrored input; the mirror projection would distort it).
  state.subs.push(
    rt.drivers.on('pose', 'raw_data', (data) => {
      const parsed = parseRawPose(data);
      if (!parsed) return;
      state.feed.raw.data = parsed;
      state.feed.raw.lastUpdate = performance.now();
    }),
  );

  state.subs.push(
    rt.drivers.on('frequency_analysis', 'frequency', (data) => {
      const parsed = parseFrequency(data);
      if (!parsed) return;
      state.feed.frequency.data = parsed;
      state.feed.frequency.lastUpdate = performance.now();
    }),
  );

  state.subs.push(
    rt.drivers.on('slr', 'new_sign', (data) => {
      const parsed = parseSign(data);
      if (!parsed) return;
      state.feed.sign.data = parsed;
      state.feed.sign.lastUpdate = performance.now();
    }),
  );
}

function asLandmarks(value: unknown): number[][] {
  if (!Array.isArray(value)) return [];
  return value.map((lm) => (Array.isArray(lm) ? lm.map(Number) : []));
}

function parseMirrored(data: unknown): MirroredData | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  return {
    body_pose: asLandmarks(d.body_pose),
    right_hand_pose: asLandmarks(d.right_hand_pose),
    left_hand_pose: asLandmarks(d.left_hand_pose),
    face_mesh: asLandmarks(d.face_mesh),
    body_world_pose: asLandmarks(d.body_world_pose),
  };
}

function parseRawPose(data: unknown): RawPoseData | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  return {
    body_pose: asLandmarks(d.body_pose),
    right_hand_pose: asLandmarks(d.right_hand_pose),
    left_hand_pose: asLandmarks(d.left_hand_pose),
    face_mesh: asLandmarks(d.face_mesh),
    body_world_pose: asLandmarks(d.body_world_pose),
    frame_width: Number(d.frame_width) || 1280,
    frame_height: Number(d.frame_height) || 720,
  };
}

function parseFrequency(data: unknown): FrequencyData | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  const max = Number(d.max_frequency);
  return {
    max_frequency: Number.isFinite(max) ? max : 0,
    amplitude: Number(d.amplitude) || 0,
    rfft: Array.isArray(d.rfft) ? (d.rfft as unknown[]).map(Number) : [],
    blocksize: typeof d.blocksize === 'number' ? d.blocksize : undefined,
    samplerate: typeof d.samplerate === 'number' ? d.samplerate : undefined,
  };
}

function parseSign(data: unknown): SignData | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  if (typeof d.guessed_sign !== 'string') return null;
  return { guessed_sign: d.guessed_sign, probability: Number(d.probability) || 0 };
}
