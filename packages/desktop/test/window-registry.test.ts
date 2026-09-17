import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { EventEmitter } from 'node:events';

/** A BrowserWindow stand-in: emits `close` then `closed`, and `close` can be prevented. */
class FakeBrowserWindow extends EventEmitter {
  static nextId = 1;
  static all: FakeBrowserWindow[] = [];
  readonly id = FakeBrowserWindow.nextId++;
  destroyed = false;
  readonly loaded: string[] = [];
  readonly webContents = Object.assign(new EventEmitter(), {
    id: this.id,
    executeJavaScript: async () => undefined,
    send: () => undefined,
  });

  constructor() {
    super();
    FakeBrowserWindow.all.push(this);
  }

  loadURL(url: string): Promise<void> {
    this.loaded.push(url);
    return Promise.resolve();
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  /** What the window manager does when the user closes the window. */
  userClose(): void {
    let prevented = false;
    this.emit('close', { preventDefault: () => (prevented = true) });
    if (!prevented) this.destroy();
  }
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('closed');
  }
  hide(): void {}
  show(): void {}
  focus(): void {}
  setBounds(): void {}
  setFullScreen(): void {}
  isFullScreen(): boolean {
    return true;
  }
  setKiosk(): void {}
  maximize(): void {}
  setAlwaysOnTop(): void {}
  setVisibleOnAllWorkspaces(): void {}
  getBounds(): object {
    return {};
  }
}

const display = {
  id: 1,
  label: 'Screen',
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1040 },
  scaleFactor: 1,
  internal: false,
};

void mock.module('electron', () => ({
  app: { isPackaged: true, quit: () => undefined },
  BrowserWindow: FakeBrowserWindow,
  powerSaveBlocker: { start: () => 1, stop: () => undefined, isStarted: () => true },
  screen: {
    getAllDisplays: () => [display],
    getPrimaryDisplay: () => display,
    getDisplayMatching: () => display,
    on: () => undefined,
  },
}));

const { WindowRegistry } = await import('../src/main/windows.js');

class FakeServer {
  readonly requests: Array<{ type: string; payload: unknown }> = [];
  async ready(): Promise<void> {}
  async request(type: string, payload: unknown): Promise<unknown> {
    this.requests.push({ type, payload });
    return { ok: true };
  }
}

function registry(): { windows: InstanceType<typeof WindowRegistry>; server: FakeServer } {
  const windows = new WindowRegistry({ rootDir: '/app/out/main', dashboardToken: 'x'.repeat(43) });
  const server = new FakeServer();
  Object.defineProperty(windows, 'server', { get: () => server });
  return { windows, server };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('WindowRegistry', () => {
  beforeEach(() => {
    FakeBrowserWindow.all = [];
  });

  test('closing an app window stops its experience and tells the listeners', async () => {
    const { windows, server } = registry();
    const closedByUser: string[] = [];
    windows.onAppWindowClosedByUser((w) => closedByUser.push(`${w.appSlug}/${w.experienceSlug}`));
    windows.openAppHost({ appSlug: 'pool', experienceSlug: 'main', displayId: 1 });
    const win = FakeBrowserWindow.all[0]!;

    win.userClose();
    await settle();
    expect(win.destroyed).toBe(true);
    expect(windows.listWindows()).toEqual([]);
    expect(closedByUser).toEqual(['pool/main']);
    expect(server.requests).toEqual([
      { type: 'experience:stop', payload: { appSlug: 'pool', experienceSlug: 'main' } },
    ]);
  });

  test('windows main closes itself neither stop the experience nor count as closed by the user', async () => {
    const { windows, server } = registry();
    const closedByUser: unknown[] = [];
    windows.onAppWindowClosedByUser((w) => closedByUser.push(w));
    windows.openAppHost({ appSlug: 'pool', experienceSlug: 'main', displayId: 1 });

    await windows.closeExperienceWindows('pool', 'main');
    expect(FakeBrowserWindow.all[0]?.destroyed).toBe(true);
    expect(server.requests).toEqual([]);
    expect(closedByUser).toEqual([]);
  });

  test('endExperience resolves once the windows are gone and the server stopped it', async () => {
    const { windows, server } = registry();
    windows.openAppHost({ appSlug: 'depth', experienceSlug: 'setup', displayId: 1 });
    windows.openControlWindow({ appSlug: 'depth', experienceSlug: 'setup' });

    const ending = windows.endExperience('depth', 'setup');
    expect(windows.endExperience('depth', 'setup')).toBe(ending);
    await ending;
    expect(FakeBrowserWindow.all.every((w) => w.destroyed)).toBe(true);
    expect(server.requests.map((r) => r.type)).toEqual(['experience:stop']);
  });
});
