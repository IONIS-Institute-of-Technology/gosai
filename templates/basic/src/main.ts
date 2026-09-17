import { createFullscreenCanvas, defineExperience, type FullscreenCanvas } from '@gosai/sdk';

interface Settings {
  dot: { color: string };
}

interface State {
  view: FullscreenCanvas;
  settings: Settings;
  ticks: number;
  angle: number;
}

/** Everything is drawn in this space; `fit()` maps it onto the window. */
const REFERENCE = { width: 1920, height: 1080 };

export default defineExperience<State>({
  async init(rt) {
    return {
      // Removed from the page when the experience stops.
      view: createFullscreenCanvas({ reference: REFERENCE, signal: rt.signal }),
      settings: await rt.settings.get<Settings>(),
      ticks: await rt.storage.get('ticks', 0),
      angle: 0,
    };
  },

  start(rt, state) {
    rt.log.info(`${rt.app.experience.name} started`);

    // The runtime removes this subscription when the experience stops.
    rt.drivers.on('heartbeat', 'tick', () => {
      state.ticks += 1;
    });
  },

  render(_rt, state, frame) {
    const { ctx } = state.view;
    state.view.fit();
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, REFERENCE.width, REFERENCE.height);

    // deltaMs is capped after a stall, so motion never jumps.
    state.angle += (frame.deltaMs / 1000) * Math.PI;
    const x = REFERENCE.width / 2 + Math.cos(state.angle) * 400;
    const y = REFERENCE.height / 2 + Math.sin(state.angle) * 300;

    ctx.fillStyle = state.settings.dot.color;
    ctx.beginPath();
    ctx.arc(x, y, 40, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#a3a3a3';
    ctx.font = '32px ui-monospace, monospace';
    ctx.fillText(`heartbeat ticks: ${state.ticks}`, 48, 72);
  },

  async stop(rt, state) {
    await rt.storage.set('ticks', state.ticks);
  },
});
