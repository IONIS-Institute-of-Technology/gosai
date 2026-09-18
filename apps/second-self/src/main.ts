/**
 * Second Self main experience: the compositor.
 *
 * - Subscribes once to the drivers the layers read (`pose_to_mirror`, `pose`,
 *   `frequency_analysis`, `slr`) and keeps the latest payloads in a shared
 *   `MirrorFeed`.
 * - Applies the mirror projection and the `slr` action set on start.
 * - Runs one layer per module in an SDK `LayerManager`, which enforces the
 *   exclusive, allowed and required relationships and renders in z-order.
 * - Keeps the overlays (menu, hands, body, face) running and lets the gesture
 *   menu launch the rest.
 * - Suspends every layer while the display sleeps.
 * - Switches to the calibration experience (src/calibrate.ts) from the menu,
 *   and as it starts on a mirror rig without a profile.
 */

import {
  createFullscreenCanvas,
  defineExperience,
  LayerManager,
  type ExperienceRuntimeContext,
  type FrameInfo,
  type FullscreenCanvas,
} from '@gosai/sdk';

import { loadMirrorProfile, openCalibration, shouldCalibrateFirst } from './shared/calibration.js';
import { DEFAULT_CONFIG, loadConfig, mergeConfig } from './shared/config.js';
import type { LayerDeps } from './shared/deps.js';
import { createMirrorFeed, keepLatest, type MirrorFeed } from './shared/feed.js';
import { MenuOptions, type LayerDef, type Layers } from './shared/layers.js';
import { Projection } from './shared/projection.js';
import { SIGN_ACTIONS } from './shared/sign.js';
import { SleepController } from './shared/sleep.js';
import { Synth } from './shared/synth.js';
import { REF_HEIGHT, REF_WIDTH, type FrameContext, type Layer } from './shared/types.js';
import { cssViewport } from './shared/ui.js';

import { createAriaLayer } from './layers/aria.js';
import { createBodyLayer } from './layers/body.js';
import { createBounceLayer } from './layers/bounce.js';
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

const REFERENCE = { width: REF_WIDTH, height: REF_HEIGHT } as const;

type LayerSpec = Omit<LayerDef, 'create'> & { readonly factory: (deps: LayerDeps) => Layer };

/** Every layer, with the relationships ported from the legacy app manager. */
const LAYERS: readonly LayerSpec[] = [
  // Launcher and overlays.
  {
    slug: 'menu',
    label: 'Menu',
    zIndex: 100,
    inMenu: false,
    overlay: true,
    persistent: true,
    // Always offers the mirror calibration: a running kiosk has no dashboard,
    // so the menu is its way into reflection mode.
    factory: (deps) =>
      createMenuLayer(deps, [
        { id: 'calibrate', label: 'Calibrate', run: () => openCalibration(deps.rt) },
      ]),
  },
  {
    slug: 'hands',
    label: 'Hands',
    zIndex: 60,
    inMenu: true,
    overlay: true,
    factory: createHandsLayer,
  },
  {
    slug: 'body',
    label: 'Body',
    zIndex: 50,
    inMenu: true,
    overlay: true,
    factory: createBodyLayer,
  },
  {
    slug: 'face',
    label: 'Face',
    zIndex: 55,
    inMenu: true,
    overlay: true,
    factory: createFaceLayer,
  },

  {
    slug: 'clock',
    label: 'Clock',
    zIndex: 40,
    inMenu: true,
    exclusive: true,
    allowed: ['face', 'body', 'hands', 'aria', 'bounce', 'poke-it'],
    factory: createClockLayer,
  },
  {
    slug: 'poke-it',
    label: 'Poke It',
    zIndex: 30,
    inMenu: true,
    exclusive: true,
    allowed: ['face', 'body', 'hands', 'aria', 'clock', 'bounce'],
    factory: createPokeItLayer,
  },
  {
    slug: 'bounce',
    label: 'Bounce',
    zIndex: 31,
    inMenu: true,
    exclusive: true,
    allowed: ['face', 'body', 'hands', 'aria', 'clock', 'poke-it'],
    factory: createBounceLayer,
  },
  {
    slug: 'show-frequency',
    label: 'Frequency',
    zIndex: 32,
    inMenu: true,
    factory: createShowFrequencyLayer,
  },
  { slug: 'show-ping', label: 'Ping', zIndex: 33, inMenu: true, factory: createShowPingLayer },
  {
    slug: 'theremine',
    label: 'Theremine',
    zIndex: 34,
    inMenu: true,
    exclusive: true,
    required: ['hands'],
    options: [{ name: 'Sound', type: 'toggle', default: true }],
    factory: createTheremineLayer,
  },
  {
    slug: 'music-training',
    label: 'Music Training',
    zIndex: 35,
    inMenu: true,
    exclusive: true,
    required: ['hands'],
    options: [
      { name: 'Show bars', type: 'toggle', default: true },
      { name: 'Play La Vie En Rose', type: 'button' },
      { name: 'Stop', type: 'button' },
    ],
    factory: createMusicTrainingLayer,
  },
  {
    slug: 'dance',
    label: 'Dance',
    zIndex: 6,
    inMenu: true,
    exclusive: true,
    allowed: ['face', 'hands', 'clock'],
    required: ['body'],
    factory: createDanceLayer,
  },
  {
    slug: 'sign-game',
    label: 'Sign Game',
    zIndex: 7,
    inMenu: true,
    exclusive: true,
    required: ['hands'],
    factory: createSignGameLayer,
  },
  {
    slug: 'sign-training',
    label: 'Sign Training',
    zIndex: 8,
    inMenu: true,
    exclusive: true,
    required: ['face', 'body', 'hands'],
    factory: createSignTrainingLayer,
  },
  {
    slug: 'aria',
    label: 'Aria',
    zIndex: 5,
    inMenu: true,
    exclusive: true,
    allowed: ['hands', 'bounce', 'clock', 'poke-it', 'show-ping'],
    factory: createAriaLayer,
  },
];

interface Session {
  readonly layers: Layers;
  readonly synth: Synth;
  readonly sleep: SleepController;
}

interface State {
  readonly surface: FullscreenCanvas;
  readonly feed: MirrorFeed;
  session: Session | null;
}

export default defineExperience<State>({
  init(rt): State {
    const surface = createFullscreenCanvas({
      reference: REFERENCE,
      mode: 'contain',
      signal: rt.signal,
    });
    return { surface, feed: createMirrorFeed(), session: null };
  },

  async start(rt, state): Promise<void> {
    const [config, profile] = await Promise.all([loadConfig(rt), loadMirrorProfile(rt)]);
    rt.log.info('second-self: starting', {
      mode: config.projection.mode,
      calibrated: profile !== null,
    });
    if (await shouldCalibrateFirst(rt, config, profile)) {
      rt.log.info('second-self: no mirror calibration profile, starting the calibration');
      openCalibration(rt);
      return;
    }

    subscribeDrivers(rt, state.feed);
    const projection = new Projection(rt, config, profile);
    warnOnFailure(rt, 'set_mirror_config', projection.apply());
    warnOnFailure(rt, 'slr set_actions', rt.drivers.execute('slr', 'set_actions', SIGN_ACTIONS));
    // Only the avatar needs the raw face mesh; it asks for it while it runs.
    warnOnFailure(rt, 'pose set_face_mesh', rt.drivers.execute('pose', 'set_face_mesh', false));

    const onError = (slug: string, err: unknown, phase = 'option'): void =>
      rt.log.warn('second-self: layer error', { slug, phase, err: String(err) });
    const synth = new Synth(rt.audio);
    const options = new MenuOptions(LAYERS, onError);
    let layers: Layers | null = null;
    const deps: LayerDeps = {
      rt,
      surface: state.surface,
      feed: state.feed,
      synth,
      options,
      projection,
      get layers(): Layers {
        if (!layers) throw new Error('layers are not ready');
        return layers;
      },
      setFaceMesh: (stream, enabled) =>
        warnOnFailure(
          rt,
          `${stream} face mesh`,
          stream === 'raw'
            ? rt.drivers.execute('pose', 'set_face_mesh', enabled)
            : rt.drivers.execute('pose_to_mirror', 'set_mirror_config', { face_mesh: enabled }),
        ),
      asset: (path) => rt.assets.url(`assets/${path}`),
    };
    layers = new LayerManager<FrameContext, LayerDef>(
      LAYERS.map(({ factory, ...spec }) => ({ ...spec, create: () => factory(deps) })),
      { onError },
    );
    const sleep = new SleepController(config.sleep, state.feed);
    state.session = { layers, synth, sleep };

    // Follow changes made from the dashboard while the experience runs.
    rt.settings.onChange((values) => {
      const next = mergeConfig(DEFAULT_CONFIG, values);
      sleep.configure(next.sleep);
      if (projection.configure(next)) warnOnFailure(rt, 'set_mirror_config', projection.apply());
    });

    for (const spec of LAYERS) if (spec.overlay) void layers.start(spec.slug);
  },

  render(_rt, state, frame: FrameInfo): void {
    const { surface, session } = state;
    if (!session) return;
    const { ctx, canvas } = surface;
    const fit = surface.fit();
    // Transparent, so the avatar's WebGL canvas below shows through; the
    // container behind both is black.
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
    const viewport = cssViewport(
      fit,
      REFERENCE,
      canvas.width > 0 ? canvas.clientWidth / canvas.width : 1,
    );

    const { layers, sleep } = session;
    sleep.update(frame.timestamp, frame.deltaMs);
    // Fully asleep: nothing to show, so layers stop drawing, playing and moving.
    if (sleep.dormant()) layers.suspend();
    else layers.resume();

    layers.render({ ctx, timestamp: frame.timestamp, deltaMs: frame.deltaMs, viewport });
    sleep.render(ctx, frame.timestamp);
  },

  async stop(rt, state): Promise<void> {
    rt.log.info('second-self: stopping');
    const session = state.session;
    state.session = null;
    if (!session) return;
    await session.layers.stopAll();
    session.synth.dispose();
  },
});

function subscribeDrivers(rt: ExperienceRuntimeContext, feed: MirrorFeed): void {
  rt.drivers.on('pose_to_mirror', 'mirrored_data', keepLatest(feed.mirror));
  // Camera-space landmarks for the avatar and sleep detection.
  rt.drivers.on('pose', 'raw_data', keepLatest(feed.raw));
  rt.drivers.on('frequency_analysis', 'frequency', keepLatest(feed.frequency));
  rt.drivers.on('slr', 'new_sign', keepLatest(feed.sign));
}

function warnOnFailure(
  rt: ExperienceRuntimeContext,
  what: string,
  request: Promise<unknown>,
): void {
  request.catch((err: unknown) => rt.log.warn(`second-self: ${what} failed`, { err: String(err) }));
}
