import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { defineExperience } from '../src/experience.js';
import { startRuntime, type RuntimeEnvironment } from '../src/runtime.js';
import type { ExperienceDefinition, ExperienceRuntimeContext, FrameInfo } from '../src/types.js';
import { FakeFrames, FakeServer, runtimeOptions } from './fakes.js';

// The app logger mirrors every entry to the console.
const consoleSpies: Array<{ mockRestore(): void }> = [];
beforeEach(() => {
  for (const method of ['log', 'warn', 'error'] as const) {
    consoleSpies.push(spyOn(console, method).mockImplementation(() => undefined));
  }
});
afterEach(() => {
  for (const spy of consoleSpies.splice(0)) spy.mockRestore();
});

function environment(overrides: Partial<RuntimeEnvironment> = {}): {
  server: FakeServer;
  frames: FakeFrames;
  env: RuntimeEnvironment;
} {
  const server = new FakeServer();
  const frames = new FakeFrames();
  return { server, frames, env: { server, frames, ...overrides } };
}

function errorLogs(server: FakeServer): string[] {
  return server
    .requestsOf('app:log')
    .map((r) => r.payload as { level: string; message: string })
    .filter((p) => p.level === 'error')
    .map((p) => p.message);
}

describe('lifecycle', () => {
  test('init receives the context and its state reaches start, render and stop', async () => {
    const { frames, env } = environment();
    const calls: string[] = [];
    let seen = null as ExperienceRuntimeContext | null;
    const definition = defineExperience<{ n: number }>({
      init(rt) {
        seen = rt;
        calls.push(`init:${rt.app.experience.name}`);
        return { n: 1 };
      },
      start(_rt, state) {
        calls.push(`start:${state.n}`);
      },
      render(_rt, state) {
        calls.push(`render:${state.n}`);
      },
      stop(_rt, state) {
        calls.push(`stop:${state.n}`);
      },
    });
    const handle = await startRuntime(definition, runtimeOptions(), env);
    expect(seen).toBe(handle.context);
    frames.tick();
    await handle.stop();
    expect(calls).toEqual(['init:Main', 'start:1', 'render:1', 'stop:1']);
  });

  test('exposes identity and launch params from the manifest and options', async () => {
    const { env } = environment();
    const handle = await startRuntime({}, runtimeOptions({ params: { role: 'control' } }), env);
    const { app } = handle.context;
    expect(app.appSlug).toBe('demo');
    expect(app.manifest.name).toBe('Demo');
    expect(app.experience.description).toBe('The main experience');
    expect(app.params).toEqual({ role: 'control' });
    expect(Object.isFrozen(app.params)).toBe(true);
    await handle.stop();
  });

  test('rejects an experience the manifest does not declare and closes the connection', async () => {
    const { server, env } = environment();
    await expect(startRuntime({}, runtimeOptions({ experienceSlug: 'nope' }), env)).rejects.toThrow(
      'no experience "nope"',
    );
    expect(server.closed).toBe(true);
  });

  test('stop is idempotent', async () => {
    const { server, env } = environment();
    let stops = 0;
    const handle = await startRuntime({ stop: () => void (stops += 1) }, runtimeOptions(), env);
    await Promise.all([handle.stop(), handle.stop()]);
    await handle.stop();
    expect(stops).toBe(1);
    expect(server.closed).toBe(true);
  });

  test('a failing start logs, runs stop, releases everything and rethrows', async () => {
    const { server, env } = environment();
    let stopped = false;
    let signal: AbortSignal | null = null;
    const definition: ExperienceDefinition<void> = {
      start(rt) {
        signal = rt.signal;
        rt.drivers.on('heartbeat', 'tick', () => undefined);
        throw new Error('no camera');
      },
      stop() {
        stopped = true;
      },
    };
    await expect(startRuntime(definition, runtimeOptions(), env)).rejects.toThrow('no camera');
    expect(stopped).toBe(true);
    expect(signal!.aborted).toBe(true);
    expect(server.listenerCount()).toBe(0);
    expect(server.closed).toBe(true);
    expect(errorLogs(server)).toEqual(['start failed']);
  });

  test('a failing init does not call stop', async () => {
    const { server, env } = environment();
    let stopped = false;
    const definition: ExperienceDefinition<void> = {
      init() {
        throw new Error('bad init');
      },
      stop() {
        stopped = true;
      },
    };
    await expect(startRuntime(definition, runtimeOptions(), env)).rejects.toThrow('bad init');
    expect(stopped).toBe(false);
    expect(server.closed).toBe(true);
  });

  test('aborting the signal during start cancels after the running hook', async () => {
    const { server, env } = environment();
    const controller = new AbortController();
    const calls: string[] = [];
    const definition: ExperienceDefinition<void> = {
      async init() {
        calls.push('init');
        controller.abort();
      },
      start: () => void calls.push('start'),
      stop: () => void calls.push('stop'),
    };
    const run = startRuntime(definition, runtimeOptions({ signal: controller.signal }), env);
    await expect(run).rejects.toThrow();
    expect(calls).toEqual(['init', 'stop']);
    expect(server.closed).toBe(true);
    expect(errorLogs(server)).toEqual([]);
  });

  test('aborting the signal after start stops the experience', async () => {
    const { server, env } = environment();
    const controller = new AbortController();
    let stopped = false;
    await startRuntime(
      { stop: () => void (stopped = true) },
      runtimeOptions({ signal: controller.signal }),
      env,
    );
    controller.abort();
    await Promise.resolve();
    expect(stopped).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(server.closed).toBe(true);
  });
});

describe('listener cleanup on stop', () => {
  test('removes driver and app event listeners the experience left open', async () => {
    const { server, env } = environment();
    const received: unknown[] = [];
    const handle = await startRuntime(
      {
        start(rt) {
          rt.drivers.on('heartbeat', 'tick', (data) => received.push(data));
          rt.drivers.on('camera', 'frame', () => undefined);
          rt.events.on('scores', (data) => received.push(data));
          const early = rt.events.on('early', () => undefined);
          early.unsubscribe();
        },
      },
      runtimeOptions(),
      env,
    );
    server.emit('driver:event:demo', { driver: 'heartbeat', event: 'tick', data: 1 });
    server.emit('app:demo:scores', 2);
    expect(received).toEqual([1, 2]);
    expect(server.listenerCount()).toBe(3);

    await handle.stop();
    expect(server.listenerCount()).toBe(0);
    expect(server.requestsOf('driver:unsubscribe').map((r) => r.payload)).toEqual([
      { driver: 'heartbeat', event: 'tick', binding: 'demo' },
      { driver: 'camera', event: 'frame', binding: 'demo' },
    ]);
    server.emit('driver:event:demo', { driver: 'heartbeat', event: 'tick', data: 3 });
    expect(received).toEqual([1, 2]);
  });

  test('an explicit unsubscribe is not repeated on stop', async () => {
    const { server, env } = environment();
    const handle = await startRuntime(
      {
        start(rt) {
          const sub = rt.drivers.on('heartbeat', 'tick', () => undefined);
          sub.unsubscribe();
          sub.unsubscribe();
        },
      },
      runtimeOptions(),
      env,
    );
    await handle.stop();
    expect(server.requestsOf('driver:unsubscribe')).toHaveLength(1);
  });

  test('subscriptions made after stop are ignored', async () => {
    const { server, env } = environment();
    const handle = await startRuntime({}, runtimeOptions(), env);
    await handle.stop();
    handle.context.drivers.on('heartbeat', 'tick', () => undefined).unsubscribe();
    handle.context.events.on('late', () => undefined);
    expect(server.listenerCount()).toBe(0);
    expect(server.requestsOf('driver:subscribe')).toHaveLength(0);
  });

  test('rt.signal aborts on stop, after the stop hook ran', async () => {
    const { env } = environment();
    let abortedDuringStop = null as boolean | null;
    const handle = await startRuntime(
      { stop: (rt) => void (abortedDuringStop = rt.signal.aborted) },
      runtimeOptions(),
      env,
    );
    expect(handle.context.signal.aborted).toBe(false);
    await handle.stop();
    expect(abortedDuringStop).toBe(false);
    expect(handle.context.signal.aborted).toBe(true);
  });

  test('uses the driver binding for driver requests', async () => {
    const { server, env } = environment();
    const handle = await startRuntime({}, runtimeOptions({ driverBinding: 'pool' }), env);
    handle.context.drivers.on('camera', 'frame', () => undefined);
    await handle.context.drivers.execute('camera', 'snap');
    expect(server.listeners.has('driver:event:pool')).toBe(true);
    expect(server.requestsOf('driver:execute')[0]?.payload).toMatchObject({ binding: 'pool' });
    await handle.stop();
  });
});

describe('render loop', () => {
  async function renderFrames(
    ticks: number[],
    options: { maxDeltaMs?: number } = {},
  ): Promise<FrameInfo[]> {
    const { frames, env } = environment();
    const seen: FrameInfo[] = [];
    const handle = await startRuntime(
      { render: (_rt, _state, frame) => void seen.push(frame) },
      runtimeOptions(options),
      env,
    );
    for (const elapsed of ticks) frames.tick(elapsed);
    await handle.stop();
    return seen;
  }

  test('reports elapsed time and counts frames', async () => {
    const seen = await renderFrames([16, 17, 20]);
    expect(seen.map((f) => f.deltaMs)).toEqual([16, 17, 20]);
    expect(seen.map((f) => f.frameCount)).toEqual([0, 1, 2]);
    expect(seen[2]!.timestamp).toBe(1000 + 16 + 17 + 20);
  });

  test('caps deltaMs after a stall', async () => {
    const seen = await renderFrames([16, 5000, 16]);
    expect(seen.map((f) => f.deltaMs)).toEqual([16, 100, 16]);
  });

  test('the cap is configurable', async () => {
    const seen = await renderFrames([16, 5000], { maxDeltaMs: 250 });
    expect(seen.map((f) => f.deltaMs)).toEqual([16, 250]);
  });

  test('stop cancels the pending frame', async () => {
    const { frames, env } = environment();
    let rendered = 0;
    const handle = await startRuntime(
      { render: () => void (rendered += 1) },
      runtimeOptions(),
      env,
    );
    frames.tick();
    expect(frames.scheduled).toBe(1);
    await handle.stop();
    expect(frames.scheduled).toBe(0);
    frames.tick();
    expect(rendered).toBe(1);
  });

  test('experiences without render schedule no frames', async () => {
    const { frames, env } = environment();
    const handle = await startRuntime({}, runtimeOptions(), env);
    expect(frames.scheduled).toBe(0);
    await handle.stop();
  });
});

describe('render errors', () => {
  test('logs a repeated error once and keeps rendering below the limit', async () => {
    const { server, frames, env } = environment();
    let frame = 0;
    const handle = await startRuntime(
      {
        render: () => {
          frame += 1;
          if (frame % 2 === 0) throw new Error('flaky');
        },
      },
      runtimeOptions({ maxRenderFailures: 3 }),
      env,
    );
    for (let i = 0; i < 20; i++) frames.tick();
    expect(frame).toBe(20);
    expect(errorLogs(server)).toEqual(['render failed']);
    expect(server.closed).toBe(false);
    await handle.stop();
  });

  test('logs distinct messages separately', async () => {
    const { server, frames, env } = environment();
    let frame = 0;
    const handle = await startRuntime(
      {
        render: () => {
          frame += 1;
          throw new Error(frame % 2 === 0 ? 'even' : 'odd');
        },
      },
      runtimeOptions({ maxRenderFailures: 100 }),
      env,
    );
    for (let i = 0; i < 10; i++) frames.tick();
    const messages = server
      .requestsOf('app:log')
      .map((r) => (r.payload as { data: { message: string } }).data.message);
    expect(messages).toEqual(['odd', 'even']);
    await handle.stop();
  });

  test('stops the experience after repeated consecutive failures', async () => {
    const { server, frames, env } = environment();
    let renders = 0;
    let stopped = false;
    let fatal: unknown = null;
    await startRuntime(
      {
        render: () => {
          renders += 1;
          throw new Error('broken');
        },
        stop: () => void (stopped = true),
      },
      runtimeOptions({ maxRenderFailures: 5, onFatalError: (err) => (fatal = err) }),
      env,
    );
    for (let i = 0; i < 20; i++) frames.tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(renders).toBe(5);
    expect(stopped).toBe(true);
    expect(server.closed).toBe(true);
    expect((fatal as Error).message).toBe('broken');
    expect(errorLogs(server)).toEqual([
      'render failed',
      'stopping after 5 consecutive render failures',
    ]);
  });
});

describe('context services', () => {
  test('ping times a system:ping round trip', async () => {
    const { server, frames, env } = environment();
    server.reply = (type) => {
      if (type === 'system:ping') frames.time += 12;
      return {};
    };
    const handle = await startRuntime({}, runtimeOptions(), env);
    expect(await handle.context.ping()).toBe(12);
    await handle.stop();
  });

  test('assets resolve against the app static route', async () => {
    const { env } = environment();
    const handle = await startRuntime({}, runtimeOptions(), env);
    expect(handle.context.assets.url('assets/audio/click one.mp3')).toBe(
      'http://demo.localhost:7777/v1/apps/demo/static/assets/audio/click%20one.mp3',
    );
    expect(handle.context.assets.url('/./assets//logo.png')).toBe(
      'http://demo.localhost:7777/v1/apps/demo/static/assets/logo.png',
    );
    await handle.stop();
  });

  test('audio is created lazily, resumed on start and closed on stop', async () => {
    const created: FakeAudioContext[] = [];
    const { env } = environment({
      createAudioContext: () => {
        const context = new FakeAudioContext();
        created.push(context);
        return context as unknown as AudioContext;
      },
    });
    let inInit: FakeAudioContext | null = null;
    const handle = await startRuntime(
      { init: (rt) => void (inInit = rt.audio as unknown as FakeAudioContext) },
      runtimeOptions(),
      env,
    );
    expect(created).toHaveLength(1);
    expect(handle.context.audio).toBe(inInit as unknown as AudioContext);
    expect(inInit!.resumes).toBe(1);
    await handle.stop();
    expect(inInit!.state).toBe('closed');
    expect(() => handle.context.audio).toThrow();
  });

  test('audio first used after start is resumed right away', async () => {
    const context = new FakeAudioContext();
    const { env } = environment({ createAudioContext: () => context as unknown as AudioContext });
    const handle = await startRuntime({}, runtimeOptions(), env);
    void handle.context.audio;
    expect(context.resumes).toBe(1);
    await handle.stop();
  });
});

class FakeAudioContext {
  state: 'suspended' | 'running' | 'closed' = 'suspended';
  resumes = 0;

  async resume(): Promise<void> {
    this.resumes += 1;
    this.state = 'running';
  }

  async close(): Promise<void> {
    this.state = 'closed';
  }
}
