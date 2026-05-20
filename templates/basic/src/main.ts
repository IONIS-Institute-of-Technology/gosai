import {
  defineExperience,
  createCanvas,
  fullscreenContainer,
  type ExperienceRuntimeContext,
  type FrameInfo,
} from '@gosai/sdk';

interface State {
  canvas: HTMLCanvasElement;
  ctx2d: CanvasRenderingContext2D;
  container: HTMLElement;
  tickCount: number;
  startTime: number;
}

export default defineExperience<State>({
  slug: 'main',
  name: 'Main',
  description: 'Bouncing dot driven by heartbeat ticks',

  init(): State {
    const container = fullscreenContainer();
    const canvas = createCanvas(container);
    const ctx2d = canvas.getContext('2d');
    if (!ctx2d) throw new Error('No 2D canvas context available');
    return {
      container,
      canvas,
      ctx2d,
      tickCount: 0,
      startTime: performance.now(),
    };
  },

  async start(rt: ExperienceRuntimeContext, state: State) {
    rt.log.info('hello-gosai main started');

    // Subscribe to the built-in heartbeat driver.
    rt.drivers.on('heartbeat', 'tick', (data) => {
      const t = data as { count: number };
      state.tickCount = t.count;
    });

    // Optional: load persisted counter from storage.
    const last = await rt.storage.get<number>('last-tick', 0);
    state.tickCount = last ?? 0;

    window.addEventListener('beforeunload', () => {
      void rt.storage.set('last-tick', state.tickCount);
    });
  },

  render(_rt: ExperienceRuntimeContext, state: State, frame: FrameInfo) {
    const { ctx2d, canvas } = state;
    const w = canvas.width;
    const h = canvas.height;

    ctx2d.fillStyle = '#000';
    ctx2d.fillRect(0, 0, w, h);

    const elapsed = (frame.timestamp - state.startTime) / 1000;
    const x = (Math.sin(elapsed) * 0.4 + 0.5) * w;
    const y = (Math.cos(elapsed * 0.7) * 0.4 + 0.5) * h;
    const r = Math.min(w, h) * 0.05;

    ctx2d.fillStyle = '#4ade80';
    ctx2d.beginPath();
    ctx2d.arc(x, y, r, 0, Math.PI * 2);
    ctx2d.fill();

    ctx2d.fillStyle = '#a3a3a3';
    ctx2d.font = `${Math.floor(h * 0.025)}px ui-monospace, monospace`;
    ctx2d.fillText(`hello-gosai · heartbeat tick #${state.tickCount}`, 24, 40);
    ctx2d.fillText(`elapsed ${elapsed.toFixed(1)}s · frame ${frame.frameCount}`, 24, 70);
  },

  async stop(rt: ExperienceRuntimeContext, state: State) {
    rt.log.info('hello-gosai main stopping');
    await rt.storage.set('last-tick', state.tickCount);
    state.container.remove();
  },
});
