import { describe, expect, test } from 'bun:test';
import type { RunningExperience } from '@gosai/shared';
import { KioskLifecycle, type KioskExit, type KioskTimers } from '../src/main/kiosk-lifecycle.js';

class ManualTimers implements KioskTimers {
  readonly pending = new Map<number, () => void>();
  private next = 1;
  set(run: () => void): number {
    const id = this.next++;
    this.pending.set(id, run);
    return id;
  }
  clear(handle: unknown): void {
    this.pending.delete(handle as number);
  }
  fire(): void {
    const runs = [...this.pending.values()];
    this.pending.clear();
    for (const run of runs) run();
  }
}

/** A kiosk whose own start already went through, unless `starting`. */
function setup({ starting = false } = {}): {
  lifecycle: KioskLifecycle;
  timers: ManualTimers;
  exits: KioskExit[];
  state(
    experienceSlug: string,
    state: RunningExperience['state'],
    extra?: Partial<RunningExperience>,
  ): void;
} {
  const timers = new ManualTimers();
  const exits: KioskExit[] = [];
  const lifecycle = new KioskLifecycle({ appSlug: 'mirror', exit: (e) => exits.push(e), timers });
  if (!starting) lifecycle.started();
  return {
    lifecycle,
    timers,
    exits,
    state: (experienceSlug, state, extra = {}) =>
      lifecycle.onExperience({
        appSlug: 'mirror',
        experienceSlug,
        state,
        startedAt: 1,
        startedAs: 'request',
        ...extra,
      }),
  };
}

describe('KioskLifecycle', () => {
  test('stays open through rt.router.switchTo', () => {
    const { state, timers, exits } = setup();
    state('menu', 'running');
    state('menu', 'stopping');
    state('menu', 'idle');
    expect(timers.pending.size).toBe(1);
    state('game', 'starting');
    expect(timers.pending.size).toBe(0);
    state('game', 'running');
    timers.fire();
    expect(exits).toEqual([]);
  });

  test('quits with 0 when the app stops its experiences and none starts', () => {
    const { state, timers, exits } = setup();
    state('main', 'running');
    state('main', 'idle');
    expect(exits).toEqual([]);
    timers.fire();
    expect(exits).toEqual([{ code: 0, reason: 'the app stopped its experiences' }]);
  });

  test('quits with 1 when the last experience crashed and none starts', () => {
    const { state, timers, exits } = setup();
    state('main', 'running');
    state('main', 'crashed');
    timers.fire();
    expect(exits).toEqual([{ code: 1, reason: 'main crashed and no experience started after it' }]);
  });

  test('passes on the error a crash reported', () => {
    const { state, timers, exits } = setup();
    const error = 'The experience stopped after 60 consecutive render errors: boom';
    state('main', 'running');
    state('main', 'stopping');
    state('main', 'crashed', { error });
    timers.fire();
    expect(exits).toEqual([
      { code: 1, reason: 'main crashed and no experience started after it', error },
    ]);
  });

  test('ignores failed attempts while its own start retries, then quits with 1', () => {
    const { lifecycle, state, timers, exits } = setup({ starting: true });
    const error = 'Python drivers are unavailable: Python is disabled (GOSAI_PYTHON=0)';
    for (let attempt = 0; attempt < 3; attempt++) {
      state('main', 'starting');
      state('main', 'crashed', { error });
    }
    expect(timers.pending.size).toBe(0);
    lifecycle.startFailed({ experienceSlug: 'main', error });
    expect(exits).toEqual([{ code: 1, reason: 'main could not start', error }]);
    timers.fire();
    expect(exits).toHaveLength(1);
  });

  test('a retry that works keeps the kiosk running', () => {
    const { lifecycle, state, timers, exits } = setup({ starting: true });
    state('main', 'starting');
    state('main', 'crashed', { error: 'Python bridge did not become ready in time' });
    state('main', 'starting');
    state('main', 'running');
    lifecycle.started();
    timers.fire();
    expect(exits).toEqual([]);
  });

  test('counts a crash that came before its start settled', () => {
    const { lifecycle, state, timers, exits } = setup({ starting: true });
    state('main', 'starting');
    state('main', 'running');
    state('main', 'crashed', { error: 'boom' });
    expect(timers.pending.size).toBe(0);
    lifecycle.started();
    timers.fire();
    expect(exits).toEqual([
      { code: 1, reason: 'main crashed and no experience started after it', error: 'boom' },
    ]);
  });

  test('keeps waiting while another requested experience runs', () => {
    const { state, timers, exits } = setup();
    state('main', 'running');
    state('overlay', 'running');
    state('main', 'idle');
    expect(timers.pending.size).toBe(0);
    state('overlay', 'idle');
    timers.fire();
    expect(exits).toHaveLength(1);
  });

  test('ignores requirements, other apps and states it never saw start', () => {
    const { state, timers, lifecycle } = setup();
    state('bg', 'running', { startedAs: 'requirement' });
    state('bg', 'idle', { startedAs: 'requirement' });
    lifecycle.onExperience({
      appSlug: 'calibration',
      experienceSlug: 'calibrate',
      state: 'idle',
      startedAt: 1,
      startedAs: 'request',
    });
    state('never-started', 'idle');
    expect(timers.pending.size).toBe(0);
  });

  test('quits with 0 at once when the user closes the window, and only once', () => {
    const { state, lifecycle, timers, exits } = setup();
    state('main', 'running');
    lifecycle.onWindowClosedByUser();
    state('main', 'idle');
    timers.fire();
    expect(exits).toEqual([{ code: 0, reason: 'the app window was closed' }]);
  });
});
