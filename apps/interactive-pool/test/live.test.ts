import { describe, expect, test } from 'bun:test';
import { createLiveLayer, MAX_BACKOFF_MS } from '../src/layers/live.js';
import { DEFAULT_SETTINGS, type PoolSettings } from '../src/settings.js';
import { createTracking } from '../src/tracking.js';
import { FakeLiveEnvironment, fakeRuntime, frame } from './fakes.js';

function relay(url: string, connect: string[] = []) {
  let settings: PoolSettings = { ...DEFAULT_SETTINGS, live: { url } };
  const env = new FakeLiveEnvironment();
  const { rt, logs } = fakeRuntime({ network: { connect } });
  const layer = createLiveLayer(rt, () => settings, env);
  const setUrl = (next: string): void => {
    settings = { ...settings, live: { url: next } };
  };
  return { layer, env, logs, setUrl, warnings: () => logs.filter((l) => l.level === 'warn') };
}

describe('live relay', () => {
  test('stays idle without a URL', () => {
    const { layer, env } = relay('');
    layer.start?.();
    layer.render?.(frame(0));
    expect(env.sockets).toEqual([]);
  });

  test('sends normalised ball positions once per ball update', () => {
    const { layer, env } = relay('wss://relay.example/ws');
    layer.start?.();
    const socket = env.latest;
    expect(socket?.url).toBe('wss://relay.example/ws');
    socket?.open();

    const tracking = createTracking();
    tracking.balls = [{ x: 960, y: 270, diameter: 80, vx: 0, vy: 0 }];
    tracking.ballsUpdatedAt = 5;
    layer.render?.(frame(10, tracking));
    layer.render?.(frame(20, tracking));
    expect(socket?.sent).toHaveLength(1);
    expect(JSON.parse(socket?.sent[0] ?? '{}').balls).toEqual([{ x: 0.5, y: 0.25 }]);
  });

  test('follows a changed URL and closes the old socket', () => {
    const { layer, env, setUrl } = relay('wss://a.example/ws');
    layer.start?.();
    const first = env.latest;
    first?.open();

    setUrl('wss://b.example/ws');
    layer.render?.(frame(0));
    expect(first?.closed).toBe(true);
    expect(env.sockets.map((s) => s.url)).toEqual(['wss://a.example/ws', 'wss://b.example/ws']);
    // Closing the replaced socket schedules nothing.
    expect(env.timers.size).toBe(0);

    setUrl('');
    layer.render?.(frame(0));
    expect(env.latest?.closed).toBe(true);
    expect(env.sockets).toHaveLength(2);
  });

  test('warns about an unlisted ws:// relay and does not connect', () => {
    const { layer, env, warnings } = relay('ws://192.168.1.50:8080/ws');
    layer.start?.();
    expect(env.sockets).toEqual([]);
    expect(warnings()[0]?.message).toContain('network.connect');

    const listed = relay('ws://192.168.1.50:8080/ws', ['ws://192.168.1.50:8080']);
    listed.layer.start?.();
    expect(listed.env.sockets).toHaveLength(1);
  });

  test('retries an unreachable relay with back-off, warning once per attempt', () => {
    const { layer, env, warnings } = relay('wss://down.example/ws');
    layer.start?.();
    const delays: number[] = [];
    for (let attempt = 0; attempt < 7; attempt++) {
      env.latest?.fail();
      delays.push(...env.delays());
      env.runTimers();
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, MAX_BACKOFF_MS, MAX_BACKOFF_MS]);
    expect(env.sockets).toHaveLength(8);
    expect(warnings().map((w) => [w.message, w.data?.retryInMs])).toEqual(
      delays.map((d) => ['live: could not connect to the relay', d]),
    );
  });

  test('reconnects a dropped connection starting from the shortest delay', () => {
    const { layer, env, warnings } = relay('wss://relay.example/ws');
    layer.start?.();
    env.latest?.fail();
    env.runTimers();
    env.latest?.open();
    env.latest?.fail();
    expect(env.delays()).toEqual([1000]);
    // Losing an open connection is logged as info, not as a failed attempt.
    expect(warnings()).toHaveLength(1);
  });

  test('stop closes the socket and cancels a pending reconnect', () => {
    const { layer, env } = relay('wss://relay.example/ws');
    layer.start?.();
    env.latest?.fail();
    env.runTimers();
    const socket = env.latest;
    socket?.fail();
    expect(env.timers.size).toBe(1);

    layer.stop?.();
    expect(env.timers.size).toBe(0);
    expect(socket?.closed).toBe(true);
    env.runTimers();
    expect(env.sockets).toHaveLength(2);
  });
});
