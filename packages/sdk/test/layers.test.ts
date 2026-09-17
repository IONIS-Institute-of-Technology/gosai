import { describe, expect, test } from 'bun:test';
import { LayerManager, type Layer, type LayerDefinition, type LayerPhase } from '../src/layers.js';

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/** A layer that records its hook calls into a shared log. */
function recorder(
  log: string[],
  slug: string,
  overrides: Partial<Layer<number>> = {},
): Layer<number> {
  return {
    start: () => void log.push(`start:${slug}`),
    render: (frame) => void log.push(`render:${slug}:${frame}`),
    stop: () => void log.push(`stop:${slug}`),
    suspend: () => void log.push(`suspend:${slug}`),
    resume: () => void log.push(`resume:${slug}`),
    ...overrides,
  };
}

function def(
  log: string[],
  slug: string,
  extra: Partial<LayerDefinition<number>> = {},
  overrides: Partial<Layer<number>> = {},
): LayerDefinition<number> {
  return { slug, create: () => recorder(log, slug, overrides), ...extra };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('LayerManager lifecycle', () => {
  test('creates and preloads a layer once across restarts', async () => {
    let created = 0;
    let preloaded = 0;
    const manager = new LayerManager<number>([
      {
        slug: 'a',
        create: () => {
          created += 1;
          return {
            preload: async () => void (preloaded += 1),
            render: () => undefined,
          };
        },
      },
    ]);
    await manager.start('a');
    await manager.stop('a');
    await manager.start('a');
    expect(created).toBe(1);
    expect(preloaded).toBe(1);
    expect(manager.isReady('a')).toBe(true);
  });

  test('renders ready layers in z-order, then registration order', async () => {
    const log: string[] = [];
    const manager = new LayerManager<number>([
      def(log, 'top', { zIndex: 10 }),
      def(log, 'bottom', { zIndex: -1 }),
      def(log, 'middle-a'),
      def(log, 'middle-b'),
    ]);
    await Promise.all(['top', 'bottom', 'middle-a', 'middle-b'].map((s) => manager.start(s)));
    log.length = 0;
    manager.render(7);
    expect(log).toEqual([
      'render:bottom:7',
      'render:middle-a:7',
      'render:middle-b:7',
      'render:top:7',
    ]);
  });

  test('a layer does not render until its start hook resolves', async () => {
    const log: string[] = [];
    const gate = deferred();
    const manager = new LayerManager<number>([def(log, 'a', {}, { start: () => gate.promise })]);
    const started = manager.start('a');
    manager.render(1);
    expect(manager.isRunning('a')).toBe(true);
    expect(manager.isReady('a')).toBe(false);
    gate.resolve();
    await started;
    manager.render(2);
    expect(log).toEqual(['render:a:2']);
  });

  test('a failed start is reported, stops the layer and calls its stop hook', async () => {
    const errors: Array<[string, LayerPhase]> = [];
    let stops = 0;
    const manager = new LayerManager<number>(
      [
        {
          slug: 'broken',
          create: () => ({
            start: () => {
              throw new Error('nope');
            },
            stop: () => void (stops += 1),
          }),
        },
      ],
      { onError: (slug, _err, phase) => errors.push([slug, phase]) },
    );
    await manager.start('broken');
    expect(errors).toEqual([['broken', 'start']]);
    expect(stops).toBe(1);
    expect(manager.isRunning('broken')).toBe(false);
    await manager.stopAll();
    expect(stops).toBe(1);
  });

  test('a failed create or preload is reported without calling stop', async () => {
    const errors: Array<[string, LayerPhase]> = [];
    let stops = 0;
    const manager = new LayerManager<number>(
      [
        {
          slug: 'no-create',
          create: () => {
            throw new Error('create');
          },
        },
        {
          slug: 'no-preload',
          create: () => ({
            preload: () => Promise.reject(new Error('preload')),
            stop: () => void (stops += 1),
          }),
        },
      ],
      { onError: (slug, _err, phase) => errors.push([slug, phase]) },
    );
    await manager.start('no-create');
    await manager.start('no-preload');
    expect(errors).toEqual([
      ['no-create', 'create'],
      ['no-preload', 'preload'],
    ]);
    expect(stops).toBe(0);
  });
});

describe('LayerManager activation tokens', () => {
  test('stopping during start stops the layer once start returns, and it never renders', async () => {
    const log: string[] = [];
    const gate = deferred();
    const manager = new LayerManager<number>([
      def(log, 'a', {}, { start: () => gate.promise.then(() => void log.push('start:a')) }),
    ]);
    const started = manager.start('a');
    await flush();
    const stopped = manager.stop('a');
    expect(manager.isRunning('a')).toBe(false);
    gate.resolve();
    await Promise.all([started, stopped]);
    manager.render(1);
    expect(log).toEqual(['start:a', 'stop:a']);
    expect(manager.isReady('a')).toBe(false);
  });

  test('start, stop, start during a slow start ends running with one extra cycle', async () => {
    const log: string[] = [];
    const gates = [deferred(), deferred()];
    let call = 0;
    const manager = new LayerManager<number>([
      def(
        log,
        'a',
        {},
        {
          start: () => {
            const gate = gates[call++]!;
            log.push(`start:a:${call}`);
            return gate.promise;
          },
        },
      ),
    ]);
    const first = manager.start('a');
    await flush();
    void manager.stop('a');
    const second = manager.start('a');
    expect(call).toBe(1);
    gates[0]!.resolve();
    await first;
    await flush();
    gates[1]!.resolve();
    await second;
    expect(log).toEqual(['start:a:1', 'stop:a', 'start:a:2']);
    expect(manager.isReady('a')).toBe(true);
  });

  test('stopping during preload skips start and stop', async () => {
    const log: string[] = [];
    const gate = deferred();
    const manager = new LayerManager<number>([def(log, 'a', {}, { preload: () => gate.promise })]);
    const started = manager.start('a');
    await flush();
    void manager.stop('a');
    gate.resolve();
    await started;
    expect(log).toEqual([]);
  });
  test('stopping before the start hook runs skips start and stop', async () => {
    const log: string[] = [];
    const manager = new LayerManager<number>([def(log, 'a')]);
    const started = manager.start('a');
    await manager.stop('a');
    await started;
    expect(log).toEqual([]);
    expect(manager.isRunning('a')).toBe(false);
  });
});

describe('LayerManager relationships', () => {
  test('exclusive layers stop others but keep persistent, allowed and required layers', async () => {
    const log: string[] = [];
    const manager = new LayerManager<number>([
      def(log, 'menu', { persistent: true }),
      def(log, 'hands'),
      def(log, 'clock'),
      def(log, 'body'),
      def(log, 'game', { exclusive: true, allowed: ['hands'], required: ['body'] }),
    ]);
    await Promise.all(['menu', 'hands', 'clock'].map((s) => manager.start(s)));
    await manager.start('game');
    await flush();
    expect(manager.running()).toEqual(['menu', 'hands', 'body', 'game']);
    expect(log).toContain('stop:clock');
    expect(log).not.toContain('stop:menu');
  });

  test('stop ignores persistent layers unless forced', async () => {
    const log: string[] = [];
    const manager = new LayerManager<number>([def(log, 'menu', { persistent: true })]);
    await manager.start('menu');
    await manager.stop('menu');
    expect(manager.isRunning('menu')).toBe(true);
    await manager.stop('menu', { force: true });
    expect(manager.isRunning('menu')).toBe(false);
  });

  test('stopAll stops every running layer once, top first', async () => {
    const log: string[] = [];
    const manager = new LayerManager<number>([
      def(log, 'menu', { persistent: true, zIndex: 100 }),
      def(log, 'a', { zIndex: 1 }),
      def(log, 'b', { zIndex: 50 }),
      def(log, 'idle'),
    ]);
    await Promise.all(['menu', 'a', 'b'].map((s) => manager.start(s)));
    log.length = 0;
    await manager.stopAll();
    await manager.stopAll();
    expect(log).toEqual(['stop:menu', 'stop:b', 'stop:a']);
    expect(manager.running()).toEqual([]);
  });

  test('stopAll waits for a stop already in flight', async () => {
    const log: string[] = [];
    const gate = deferred();
    const manager = new LayerManager<number>([
      def(log, 'slow', {}, { stop: () => gate.promise.then(() => void log.push('stopped:slow')) }),
    ]);
    await manager.start('slow');
    void manager.stop('slow');
    let done = false;
    const all = manager.stopAll().then(() => (done = true));
    await flush();
    expect(done).toBe(false);
    gate.resolve();
    await all;
    expect(log).toEqual(['start:slow', 'stopped:slow']);
  });

  test('toggle starts and stops', async () => {
    const manager = new LayerManager<number>([def([], 'a')]);
    await manager.toggle('a');
    expect(manager.isRunning('a')).toBe(true);
    await manager.toggle('a');
    expect(manager.isRunning('a')).toBe(false);
  });

  test('definitions keep app-specific fields', () => {
    interface MenuLayer extends LayerDefinition<number> {
      readonly label: string;
    }
    const manager = new LayerManager<number, MenuLayer>([
      { slug: 'a', label: 'Layer A', create: () => ({}) },
    ]);
    expect(manager.definition('a')?.label).toBe('Layer A');
    expect(manager.definitions().map((d) => d.label)).toEqual(['Layer A']);
  });

  test('rejects duplicate slugs', () => {
    expect(() => new LayerManager([def([], 'a'), def([], 'a')])).toThrow('duplicate');
  });
});

describe('LayerManager suspend and resume', () => {
  test('suspended layers do not render and get their hooks', async () => {
    const log: string[] = [];
    const manager = new LayerManager<number>([def(log, 'a'), def(log, 'b')]);
    await manager.start('a');
    log.length = 0;
    manager.suspend();
    manager.suspend();
    manager.render(1);
    await manager.start('b');
    manager.resume();
    manager.render(2);
    expect(log).toEqual([
      'suspend:a',
      'start:b',
      'suspend:b',
      'resume:a',
      'resume:b',
      'render:a:2',
      'render:b:2',
    ]);
    expect(manager.isSuspended()).toBe(false);
  });
});

describe('LayerManager render errors', () => {
  test('reports a render error once and stops the layer after repeated failures', async () => {
    const log: string[] = [];
    const errors: string[] = [];
    const manager = new LayerManager<number>(
      [
        def(
          log,
          'bad',
          {},
          {
            render: () => {
              throw new Error('boom');
            },
          },
        ),
        def(log, 'good'),
      ],
      { maxRenderFailures: 3, onError: (slug, _err, phase) => errors.push(`${slug}:${phase}`) },
    );
    await manager.start('bad');
    await manager.start('good');
    for (let frame = 0; frame < 5; frame++) manager.render(frame);
    await flush();
    expect(errors).toEqual(['bad:render']);
    expect(manager.isRunning('bad')).toBe(false);
    expect(log).toContain('stop:bad');
    expect(log.filter((entry) => entry.startsWith('render:good'))).toHaveLength(5);
  });

  test('a successful frame resets the failure count', async () => {
    let frame = 0;
    const manager = new LayerManager<number>(
      [
        {
          slug: 'flaky',
          create: () => ({
            render: () => {
              if (frame % 2 === 0) throw new Error('even frame');
            },
          }),
        },
      ],
      { maxRenderFailures: 2 },
    );
    await manager.start('flaky');
    for (; frame < 10; frame++) manager.render(frame);
    expect(manager.isRunning('flaky')).toBe(true);
  });
});
