import { describe, expect, test } from 'bun:test';
import type { ConnectionStatus } from '@gosai/shared/client';
import {
  CalibrationOrchestrator,
  type CalibrationServer,
  type CalibrationWindows,
} from '../src/main/calibration.js';
import type { OpenAppHostOptions, OpenControlWindowOptions } from '../src/main/windows.js';

type Manifest = { slug: string; calibration?: Record<string, unknown> };

class FakeServer {
  readonly requests: Array<{ type: string; payload: unknown }> = [];
  readonly listeners = new Map<string, Set<(payload: unknown) => void>>();
  readonly statusListeners = new Set<(status: ConnectionStatus) => void>();
  apps: Manifest[] = [
    { slug: 'calibration' },
    { slug: 'pool', calibration: { kind: 'camera-projector-surface', required: true } },
    { slug: 'depth', calibration: { kind: 'acme-depth', required: false, experience: 'setup' } },
    { slug: 'plain' },
  ];
  failStart: Error | null = null;
  appDisplay: number | null = null;

  async ready(): Promise<void> {}

  async request(type: string, payload: unknown = {}): Promise<unknown> {
    this.requests.push({ type, payload });
    switch (type) {
      case 'apps:list':
        return { apps: this.apps.map((manifest) => ({ manifest })), invalid: [] };
      case 'experience:start':
        if (this.failStart) throw this.failStart;
        return {};
      case 'app:config:get':
        return this.appDisplay === null ? {} : { display: { id: this.appDisplay } };
      case 'config:get':
        return { displayId: 2 };
      default:
        return {};
    }
  }

  on(event: string, listener: (payload: unknown) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(listener);
    return () => set.delete(listener);
  }

  onStatus(listener: (status: ConnectionStatus) => void): () => void {
    this.statusListeners.add(listener);
    listener('connected');
    return () => this.statusListeners.delete(listener);
  }

  emit(event: string, payload: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }

  setStatus(status: ConnectionStatus): void {
    for (const listener of this.statusListeners) listener(status);
  }

  listenerCount(): number {
    return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0);
  }
}

class FakeWindow {
  private readonly closedListeners: Array<() => void> = [];
  private readonly goneListeners: Array<(event: unknown, details: { reason: string }) => void> = [];
  closed = false;
  readonly webContents = {
    once: (
      _event: 'render-process-gone',
      listener: (event: unknown, details: { reason: string }) => void,
    ) => this.goneListeners.push(listener),
  };

  crash(reason: string): void {
    for (const listener of this.goneListeners.splice(0)) listener({}, { reason });
  }

  once(_event: 'closed', listener: () => void): this {
    this.closedListeners.push(listener);
    return this;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.closedListeners.splice(0)) listener();
  }
}

class FakeWindows implements CalibrationWindows {
  readonly fake = new FakeServer();
  readonly controls: Array<{ options: OpenControlWindowOptions; window: FakeWindow }> = [];
  readonly projectors: Array<{ options: OpenAppHostOptions; window: FakeWindow }> = [];
  readonly ended: string[] = [];
  readonly opened: string[] = [];

  get server(): CalibrationServer {
    return this.fake as unknown as CalibrationServer;
  }

  openControlWindow(options: OpenControlWindowOptions): { window: FakeWindow } {
    const window = new FakeWindow();
    this.controls.push({ options, window });
    this.opened.push('control');
    return { window };
  }

  openAppHost(options: OpenAppHostOptions): { window: FakeWindow } {
    const window = new FakeWindow();
    this.projectors.push({ options, window });
    this.opened.push('projector');
    return { window };
  }

  /** Resolves when `finishEnding` is called, or at once when `holdEnding` is off. */
  holdEnding = false;
  private readonly endings: Array<() => void> = [];

  endExperience(appSlug: string, experienceSlug: string): Promise<void> {
    this.ended.push(`${appSlug}/${experienceSlug}`);
    for (const { window } of [...this.controls, ...this.projectors]) window.close();
    if (!this.holdEnding) return Promise.resolve();
    return new Promise((resolve) => this.endings.push(resolve));
  }

  finishEnding(): void {
    for (const resolve of this.endings.splice(0)) resolve();
  }

  listDisplays(): { id: number }[] {
    return [{ id: 1 }, { id: 2 }, { id: 3 }];
  }

  primaryDisplay(): { id: number } {
    return { id: 1 };
  }
}

/** Waits until both windows are open. */
async function windowsOpen(windows: FakeWindows): Promise<void> {
  for (let i = 0; i < 50 && windows.opened.length < 2; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  expect(windows.opened).toEqual(['control', 'projector']);
}

describe('CalibrationOrchestrator', () => {
  test('runs a built-in kind in the calibration app with the target binding and reports success', async () => {
    const windows = new FakeWindows();
    const orchestrator = new CalibrationOrchestrator(windows);
    const run = orchestrator.run({ appSlug: 'pool', displayId: 3 });
    await windowsOpen(windows);

    const start = windows.fake.requests.find((r) => r.type === 'experience:start');
    expect(start?.payload).toEqual({
      appSlug: 'calibration',
      experienceSlug: 'calibrate',
      driverBinding: 'pool',
    });
    expect(windows.controls[0]?.options).toMatchObject({
      appSlug: 'calibration',
      experienceSlug: 'calibrate',
      targetAppSlug: 'pool',
      driverBinding: 'pool',
    });
    expect(windows.projectors[0]?.options).toMatchObject({
      appSlug: 'calibration',
      displayId: 3,
      targetAppSlug: 'pool',
      driverBinding: 'pool',
      fullscreen: true,
    });

    windows.fake.emit('app:calibration:wizard:finished', { ok: true });
    expect(await run).toEqual({ ok: true });
    expect(windows.ended).toEqual(['calibration/calibrate']);
    expect(windows.controls[0]?.window.closed).toBe(true);
    expect(windows.projectors[0]?.window.closed).toBe(true);
    expect(windows.fake.listenerCount()).toBe(0);
    expect(windows.fake.statusListeners.size).toBe(0);
  });

  test('claims the flow experience from the start request until it has ended', async () => {
    const windows = new FakeWindows();
    windows.holdEnding = true;
    const log: string[] = [];
    const claims = {
      claim: (appSlug: string, experienceSlug: string) => {
        log.push(`claim ${appSlug}/${experienceSlug}`);
        return () => log.push('release');
      },
    };
    let settled = false;
    const run = new CalibrationOrchestrator(windows, claims).run({ appSlug: 'pool' });
    void run.then(() => (settled = true));
    await windowsOpen(windows);
    expect(log).toEqual(['claim calibration/calibrate']);
    windows.fake.emit('app:calibration:wizard:finished', { ok: true });
    await new Promise((resolve) => setTimeout(resolve, 5));
    // The windows are closing and the server hasn't stopped the flow yet.
    expect(windows.ended).toEqual(['calibration/calibrate']);
    expect(log).toEqual(['claim calibration/calibrate']);
    expect(settled).toBe(false);

    windows.finishEnding();
    expect(await run).toEqual({ ok: true });
    expect(log).toEqual(['claim calibration/calibrate', 'release']);
  });

  test('a load failure reported by the flow closes both windows and returns the error', async () => {
    const windows = new FakeWindows();
    const run = new CalibrationOrchestrator(windows).run({ appSlug: 'pool' });
    await windowsOpen(windows);
    windows.fake.emit('app:calibration:wizard:finished', {
      ok: false,
      error: 'App pool is not installed',
    });
    expect(await run).toEqual({ ok: false, error: 'App pool is not installed' });
    expect(windows.ended).toEqual(['calibration/calibrate']);
    expect(windows.projectors[0]?.window.closed).toBe(true);
  });

  test('closing a window cancels the run and closes the other one', async () => {
    const windows = new FakeWindows();
    const run = new CalibrationOrchestrator(windows).run({ appSlug: 'pool' });
    await windowsOpen(windows);
    windows.controls[0]?.window.close();
    expect(await run).toEqual({
      ok: false,
      cancelled: true,
      error: 'The calibration window was closed',
    });
    expect(windows.projectors[0]?.window.closed).toBe(true);
    expect(windows.ended).toEqual(['calibration/calibrate']);
  });

  test('a crashed window ends the run and closes both windows', async () => {
    const windows = new FakeWindows();
    const run = new CalibrationOrchestrator(windows).run({ appSlug: 'pool' });
    await windowsOpen(windows);
    windows.projectors[0]?.window.crash('crashed');
    expect(await run).toEqual({ ok: false, error: 'The projector window crashed (crashed)' });
    expect(windows.controls[0]?.window.closed).toBe(true);
    expect(windows.ended).toEqual(['calibration/calibrate']);
  });

  test('a lost server connection ends the run instead of waiting forever', async () => {
    const windows = new FakeWindows();
    const run = new CalibrationOrchestrator(windows).run({ appSlug: 'pool' });
    await windowsOpen(windows);
    windows.fake.setStatus('disconnected');
    expect(await run).toMatchObject({ ok: false, error: expect.stringContaining('connection') });
    expect(windows.controls[0]?.window.closed).toBe(true);
  });

  test('a failed start reports the error and opens no window', async () => {
    const windows = new FakeWindows();
    windows.fake.failStart = new Error('camera failed to start');
    const result = await new CalibrationOrchestrator(windows).run({ appSlug: 'pool' });
    expect(result).toEqual({ ok: false, error: 'camera failed to start' });
    expect(windows.opened).toEqual([]);
    expect(windows.ended).toEqual(['calibration/calibrate']);
  });

  test("runs a custom flow in the app's own experience, without a foreign binding", async () => {
    const windows = new FakeWindows();
    const run = new CalibrationOrchestrator(windows).run({ appSlug: 'depth' });
    await windowsOpen(windows);
    expect(windows.fake.requests.find((r) => r.type === 'experience:start')?.payload).toEqual({
      appSlug: 'depth',
      experienceSlug: 'setup',
    });
    expect(windows.controls[0]?.options).toEqual({
      appSlug: 'depth',
      experienceSlug: 'setup',
      targetAppSlug: 'depth',
      title: 'Calibration · depth',
      width: 960,
      height: 720,
    });
    // A result that isn't well formed counts as a failure.
    windows.fake.emit('app:depth:wizard:finished', { ok: 'yes' });
    expect(await run).toEqual({ ok: false, error: 'Calibration failed' });
    expect(windows.ended).toEqual(['depth/setup']);
  });

  test('picks the app display, then the global one, then the primary one', async () => {
    const windows = new FakeWindows();
    const orchestrator = new CalibrationOrchestrator(windows);
    const displayOf = async (): Promise<number | undefined> => {
      const run = orchestrator.run({ appSlug: 'pool' });
      await windowsOpen(windows);
      const displayId = windows.projectors.at(-1)?.options.displayId;
      windows.fake.emit('app:calibration:wizard:finished', { ok: true });
      await run;
      windows.opened.length = 0;
      return displayId;
    };
    windows.fake.appDisplay = 3;
    expect(await displayOf()).toBe(3);
    // An assignment to a display that is gone falls back to the global display.
    windows.fake.appDisplay = 99;
    expect(await displayOf()).toBe(2);
    windows.listDisplays = () => [{ id: 1 }];
    expect(await displayOf()).toBe(1);
  });

  test('refuses apps without calibration, a missing runner and a second run', async () => {
    const windows = new FakeWindows();
    const orchestrator = new CalibrationOrchestrator(windows);
    expect(await orchestrator.run({ appSlug: 'plain' })).toEqual({
      ok: false,
      error: 'plain does not declare calibration',
    });
    expect(await orchestrator.run({ appSlug: 'ghost' })).toEqual({
      ok: false,
      error: 'ghost is not installed',
    });

    const first = orchestrator.run({ appSlug: 'pool' });
    expect(await orchestrator.run({ appSlug: 'depth' })).toEqual({
      ok: false,
      error: 'The calibration of pool is still running',
    });
    await windowsOpen(windows);
    windows.fake.emit('app:calibration:wizard:finished', { ok: true });
    await first;

    windows.fake.apps = windows.fake.apps.filter((app) => app.slug !== 'calibration');
    expect(await orchestrator.run({ appSlug: 'pool' })).toEqual({
      ok: false,
      error: 'The built-in calibration app is not installed',
    });
    expect(windows.opened).toEqual(['control', 'projector']);
  });
});
