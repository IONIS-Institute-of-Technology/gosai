import { describe, expect, test } from 'bun:test';
import type { RunningExperience } from '@gosai/shared';
import type { ConnectionStatus } from '@gosai/shared/client';
import {
  ExperienceWindows,
  type ExperienceWindowHost,
  type ExperienceWindowServer,
} from '../src/main/experience-windows.js';
import { KioskLifecycle, type KioskExit } from '../src/main/kiosk-lifecycle.js';
import type { OpenAppHostOptions } from '../src/main/windows.js';

class FakeServer {
  readonly listeners = new Map<string, Set<(payload: unknown) => void>>();
  readonly statusListeners = new Set<(status: ConnectionStatus) => void>();
  running: RunningExperience[] = [];
  appSettings: Record<string, unknown> = {};
  displayId: number | null = null;
  /** Holds `app:config:get` until released, to test races. */
  gate: Promise<void> | null = null;

  async request(type: string, payload: { appSlug?: string } = {}): Promise<unknown> {
    switch (type) {
      case 'experiences:list':
        return { experiences: this.running };
      case 'app:config:get':
        await this.gate;
        return this.appSettings[payload.appSlug ?? ''] ?? {};
      case 'config:get':
        return { displayId: this.displayId };
      default:
        throw new Error(`unexpected ${type}`);
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
    listener('disconnected');
    return () => this.statusListeners.delete(listener);
  }

  state(
    appSlug: string,
    experienceSlug: string,
    state: RunningExperience['state'],
    startedAs: RunningExperience['startedAs'] = 'request',
    error?: string,
  ): void {
    const payload: RunningExperience = {
      appSlug,
      experienceSlug,
      state,
      startedAt: 1,
      startedAs,
      ...(error !== undefined ? { error } : {}),
    };
    for (const listener of this.listeners.get('experience:state-changed') ?? []) listener(payload);
  }

  connect(): void {
    for (const listener of this.statusListeners) listener('connected');
  }
}

class FakeHost implements ExperienceWindowHost {
  readonly fake = new FakeServer();
  readonly windows: OpenAppHostOptions[] = [];
  readonly closed: string[] = [];

  get server(): ExperienceWindowServer {
    return this.fake as unknown as ExperienceWindowServer;
  }

  openExperiences(): { appSlug: string; experienceSlug: string }[] {
    return this.windows;
  }

  openAppHost(options: OpenAppHostOptions): void {
    this.windows.push(options);
  }

  closeExperienceWindows(appSlug: string, experienceSlug: string): void {
    this.closed.push(`${appSlug}/${experienceSlug}`);
    const kept = this.windows.filter(
      (w) => w.appSlug !== appSlug || w.experienceSlug !== experienceSlug,
    );
    this.windows.splice(0, this.windows.length, ...kept);
  }

  listDisplays(): { id: number }[] {
    return [{ id: 1 }, { id: 2 }, { id: 3 }];
  }

  primaryDisplay(): { id: number } {
    return { id: 1 };
  }
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function setup(): { host: FakeHost; controller: ExperienceWindows } {
  const host = new FakeHost();
  const controller = new ExperienceWindows(host, { log: () => undefined });
  controller.start();
  return { host, controller };
}

describe('ExperienceWindows', () => {
  test('opens a window when an experience runs and closes it when it stops', async () => {
    const { host } = setup();
    host.fake.state('pool', 'main', 'starting');
    await settle();
    expect(host.windows).toEqual([]);

    host.fake.state('pool', 'main', 'running');
    await settle();
    expect(host.windows).toEqual([
      { appSlug: 'pool', experienceSlug: 'main', displayId: 1, fullscreen: true },
    ]);

    host.fake.state('pool', 'main', 'stopping');
    expect(host.closed).toEqual([]);
    host.fake.state('pool', 'main', 'idle');
    expect(host.closed).toEqual(['pool/main']);
    expect(host.windows).toEqual([]);
  });

  test('follows rt.router.switchTo: the old window closes and the new experience gets one', async () => {
    const { host } = setup();
    host.fake.state('mirror', 'menu', 'running');
    await settle();
    // switchTo stops the current experience, then starts the next one.
    host.fake.state('mirror', 'menu', 'stopping');
    host.fake.state('mirror', 'menu', 'idle');
    host.fake.state('mirror', 'game', 'starting');
    host.fake.state('mirror', 'game', 'running');
    await settle();
    expect(host.closed).toEqual(['mirror/menu']);
    expect(host.windows.map((w) => w.experienceSlug)).toEqual(['game']);
  });

  test('closes the window of a crashed experience', async () => {
    const { host } = setup();
    host.fake.state('pool', 'main', 'running');
    await settle();
    host.fake.state('pool', 'main', 'crashed');
    expect(host.closed).toEqual(['pool/main']);
    expect(host.windows).toEqual([]);
  });

  test('a crash the window reported closes it, and a kiosk quits with 1 and shows why', async () => {
    const { host } = setup();
    const exits: KioskExit[] = [];
    const kiosk = new KioskLifecycle({ appSlug: 'pool', graceMs: 0, exit: (e) => exits.push(e) });
    host.fake.on('experience:state-changed', (e) => kiosk.onExperience(e as RunningExperience));
    host.fake.state('pool', 'main', 'starting');
    host.fake.state('pool', 'main', 'running');
    kiosk.started();
    await settle();
    expect(host.windows).toHaveLength(1);

    // What the server sends after the window's runtime stopped with experience:stop and an error.
    const error = 'The experience stopped after 60 consecutive render errors: boom';
    host.fake.state('pool', 'main', 'stopping');
    host.fake.state('pool', 'main', 'crashed', 'request', error);
    expect(host.closed).toEqual(['pool/main']);
    await settle();
    expect(exits).toEqual([
      { code: 1, reason: 'main crashed and no experience started after it', error },
    ]);
  });

  test("opens on the app's display in its mode, then the global display", async () => {
    const { host } = setup();
    host.fake.appSettings = { pool: { display: { id: 3, mode: 'windowed' } } };
    host.fake.displayId = 2;
    host.fake.state('pool', 'main', 'running');
    host.fake.state('mirror', 'main', 'running');
    await settle();
    expect(host.windows).toEqual([
      { appSlug: 'pool', experienceSlug: 'main', displayId: 3, fullscreen: false },
      { appSlug: 'mirror', experienceSlug: 'main', displayId: 2, fullscreen: true },
    ]);
  });

  test('opens one window per experience, and none when it stops while the display resolves', async () => {
    const { host } = setup();
    let release = (): void => undefined;
    host.fake.gate = new Promise((resolve) => (release = resolve));
    host.fake.state('pool', 'main', 'running');
    host.fake.state('pool', 'main', 'running');
    host.fake.state('solo', 'main', 'running');
    host.fake.state('solo', 'main', 'idle');
    release();
    await settle();
    expect(host.windows.map((w) => w.appSlug)).toEqual(['pool']);
  });

  test('leaves claimed experiences to their owner, but still closes them', async () => {
    const { host, controller } = setup();
    const release = controller.claim('calibration', 'calibrate');
    host.fake.state('calibration', 'calibrate', 'running');
    await settle();
    expect(host.windows).toEqual([]);
    host.fake.state('calibration', 'calibrate', 'idle');
    expect(host.closed).toEqual(['calibration/calibrate']);

    release();
    host.fake.state('calibration', 'calibrate', 'running');
    await settle();
    expect(host.windows).toHaveLength(1);
  });

  test('on connect, opens windows for running experiences and closes the stale ones it opened', async () => {
    const { host } = setup();
    host.fake.state('gone', 'main', 'running');
    await settle();
    // Windows someone else opened, such as a calibration flow's, stay.
    host.windows.push({ appSlug: 'calibration', experienceSlug: 'calibrate', displayId: 1 });
    host.fake.running = [
      {
        appSlug: 'pool',
        experienceSlug: 'main',
        state: 'running',
        startedAt: 1,
        startedAs: 'request',
      },
      {
        appSlug: 'base',
        experienceSlug: 'bg',
        state: 'running',
        startedAt: 1,
        startedAs: 'requirement',
      },
      {
        appSlug: 'mirror',
        experienceSlug: 'main',
        state: 'starting',
        startedAt: 1,
        startedAs: 'request',
      },
    ];
    host.fake.connect();
    await settle();
    await settle();
    expect(host.closed).toEqual(['gone/main']);
    expect(host.windows.map((w) => w.appSlug)).toEqual(['calibration', 'pool']);
  });

  test('leaves experiences that only run as a requirement headless', async () => {
    const { host } = setup();
    // Starting `main` with required: ["bg"] starts bg first.
    host.fake.state('pool', 'bg', 'starting', 'requirement');
    host.fake.state('pool', 'bg', 'running', 'requirement');
    host.fake.state('pool', 'main', 'starting');
    host.fake.state('pool', 'main', 'running');
    await settle();
    expect(host.windows.map((w) => w.experienceSlug)).toEqual(['main']);

    // Closing main's window stops main only; bg never had a window.
    host.fake.state('pool', 'main', 'idle');
    expect(host.windows).toEqual([]);

    // A client asking for bg itself makes it requested, and it gets a window.
    host.fake.state('pool', 'bg', 'running', 'request');
    await settle();
    expect(host.windows.map((w) => w.experienceSlug)).toEqual(['bg']);
  });

  test('opens where a custom display resolver says', async () => {
    const host = new FakeHost();
    new ExperienceWindows(host, {
      log: () => undefined,
      resolveDisplay: () => ({ displayId: 2, fullscreen: false }),
    }).start();
    host.fake.state('kiosk', 'main', 'running');
    await settle();
    expect(host.windows).toEqual([
      { appSlug: 'kiosk', experienceSlug: 'main', displayId: 2, fullscreen: false },
    ]);
  });

  test('stop() removes its listeners', () => {
    const { host, controller } = setup();
    controller.stop();
    const count = [...host.fake.listeners.values()].reduce((sum, set) => sum + set.size, 0);
    expect(count).toBe(0);
    expect(host.fake.statusListeners.size).toBe(0);
  });
});
