import { app, BrowserWindow, screen, type Display } from 'electron';
import { join } from 'node:path';
import { IPC_CHANNELS } from './channels.js';

interface WindowRegistryOptions {
  readonly rootDir: string;
  readonly serverBaseUrl?: string;
}

interface AppHostHandle {
  readonly id: number;
  readonly window: BrowserWindow;
  readonly displayId: number;
  readonly appSlug: string;
  readonly experienceSlug: string;
}

interface ControlWindowHandle {
  readonly id: number;
  readonly window: BrowserWindow;
  readonly appSlug: string;
  readonly experienceSlug: string;
}

export interface DisplaySummary {
  readonly id: number;
  readonly label: string;
  readonly bounds: { x: number; y: number; width: number; height: number };
  readonly workArea: { x: number; y: number; width: number; height: number };
  readonly scaleFactor: number;
  readonly primary: boolean;
  readonly internal: boolean;
}

export interface OpenAppHostOptions {
  readonly displayId: number;
  readonly appSlug: string;
  readonly experienceSlug: string;
  readonly fullscreen?: boolean;
}

export interface OpenControlWindowOptions {
  readonly appSlug: string;
  readonly experienceSlug: string;
  readonly projectorDisplayId?: number;
  readonly width?: number;
  readonly height?: number;
  readonly title?: string;
}

const isDev = !app.isPackaged;
const isMac = process.platform === 'darwin';

export class WindowRegistry {
  private dashboard: BrowserWindow | null = null;
  private readonly appHosts = new Map<number, AppHostHandle>();
  private readonly controlWindows = new Map<number, ControlWindowHandle>();
  private readonly endingExperiences = new Set<string>();
  private shuttingDown = false;
  private readonly serverBaseUrl: string;

  constructor(private readonly options: WindowRegistryOptions) {
    this.serverBaseUrl = options.serverBaseUrl ?? 'http://127.0.0.1:7777';
  }

  setShuttingDown(): void {
    this.shuttingDown = true;
  }

  openDashboard(): BrowserWindow {
    if (this.dashboard && !this.dashboard.isDestroyed()) {
      this.dashboard.focus();
      return this.dashboard;
    }

    const win = new BrowserWindow({
      width: 1280,
      height: 800,
      minWidth: 1024,
      minHeight: 640,
      title: 'GOSAI',
      backgroundColor: '#0a0a0a',
      autoHideMenuBar: true,
      show: false,
      webPreferences: {
        preload: join(this.options.rootDir, '../preload/dashboard.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });

    win.once('ready-to-show', () => win.show());

    if (isDev && process.env.ELECTRON_RENDERER_URL) {
      void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/dashboard.html`);
    } else {
      void win.loadFile(join(this.options.rootDir, '../renderer/dashboard.html'));
    }

    win.on('closed', () => {
      if (this.dashboard === win) this.dashboard = null;
      app.quit();
    });

    this.dashboard = win;
    return win;
  }

  listDisplays(): DisplaySummary[] {
    return screen.getAllDisplays().map((d) => this.summarizeDisplay(d));
  }

  primaryDisplay(): DisplaySummary {
    return this.summarizeDisplay(screen.getPrimaryDisplay());
  }

  openAppHost(opts: OpenAppHostOptions): AppHostHandle {
    const display = this.findDisplay(opts.displayId);
    const bounds = display.bounds;
    const wantsFullscreen = opts.fullscreen ?? true;

    const win = new BrowserWindow({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      frame: false,
      fullscreen: wantsFullscreen,
      ...(isMac ? { simpleFullscreen: false } : {}),
      backgroundColor: '#000000',
      autoHideMenuBar: true,
      show: false,
      webPreferences: {
        preload: join(this.options.rootDir, '../preload/app-host.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });

    let shown = false;
    let fallbackTimer: NodeJS.Timeout | undefined;
    const showWindow = (): void => {
      if (shown || win.isDestroyed()) return;
      shown = true;
      if (fallbackTimer) clearTimeout(fallbackTimer);
      win.show();
      win.focus();
      if (wantsFullscreen && isMac) win.setKiosk(true);
    };

    win.once('ready-to-show', showWindow);
    win.webContents.once('did-finish-load', showWindow);
    fallbackTimer = setTimeout(showWindow, 3000);

    const query = new URLSearchParams({
      app: opts.appSlug,
      experience: opts.experienceSlug,
      display: String(display.id),
    });

    if (isDev && process.env.ELECTRON_RENDERER_URL) {
      void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/app-host.html?${query.toString()}`);
    } else {
      void win.loadFile(join(this.options.rootDir, '../renderer/app-host.html'), {
        search: `?${query.toString()}`,
      });
    }

    const handle: AppHostHandle = {
      id: win.id,
      window: win,
      displayId: display.id,
      appSlug: opts.appSlug,
      experienceSlug: opts.experienceSlug,
    };

    this.appHosts.set(handle.id, handle);
    win.on('closed', () => {
      if (!this.appHosts.delete(handle.id)) return;
      if (this.hasControlFor(opts.appSlug, opts.experienceSlug)) return;
      this.stopExperienceOnServer(opts.appSlug, opts.experienceSlug);
    });

    return handle;
  }

  closeAppHost(windowId: number): boolean {
    const handle = this.appHosts.get(windowId);
    if (!handle) return false;
    this.appHosts.delete(windowId);
    if (!handle.window.isDestroyed()) handle.window.destroy();
    if (!this.hasControlFor(handle.appSlug, handle.experienceSlug)) {
      this.stopExperienceOnServer(handle.appSlug, handle.experienceSlug);
    }
    return true;
  }

  closeAllAppHosts(): void {
    for (const handle of this.appHosts.values()) {
      try {
        if (!handle.window.isDestroyed()) handle.window.destroy();
      } catch {
        // already destroyed
      }
    }
    this.appHosts.clear();
  }

  openControlWindow(opts: OpenControlWindowOptions): ControlWindowHandle {
    const dashboardDisplay = this.dashboard
      ? screen.getDisplayMatching(this.dashboard.getBounds())
      : screen.getPrimaryDisplay();
    const work = dashboardDisplay.workArea;
    const width = opts.width ?? Math.min(960, work.width - 80);
    const height = opts.height ?? Math.min(720, work.height - 80);
    const x = Math.round(work.x + (work.width - width) / 2);
    const y = Math.round(work.y + (work.height - height) / 2);

    const win = new BrowserWindow({
      x,
      y,
      width,
      height,
      title: opts.title ?? `${opts.appSlug} – control`,
      backgroundColor: '#0a0a0a',
      autoHideMenuBar: true,
      alwaysOnTop: true,
      show: false,
      webPreferences: {
        preload: join(this.options.rootDir, '../preload/app-host.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });

    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

    win.once('ready-to-show', () => {
      win.show();
      win.focus();
    });

    const query = new URLSearchParams({
      app: opts.appSlug,
      experience: opts.experienceSlug,
      role: 'control',
    });

    if (isDev && process.env.ELECTRON_RENDERER_URL) {
      void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/app-host.html?${query.toString()}`);
    } else {
      void win.loadFile(join(this.options.rootDir, '../renderer/app-host.html'), {
        search: `?${query.toString()}`,
      });
    }

    const handle: ControlWindowHandle = {
      id: win.id,
      window: win,
      appSlug: opts.appSlug,
      experienceSlug: opts.experienceSlug,
    };

    this.controlWindows.set(handle.id, handle);
    win.on('close', () => {
      this.endExperience(opts.appSlug, opts.experienceSlug, handle.id);
    });

    return handle;
  }

  closeControlWindow(windowId: number): boolean {
    const handle = this.controlWindows.get(windowId);
    if (!handle) return false;
    if (!handle.window.isDestroyed()) handle.window.close();
    return true;
  }

  setControlWindowVisible(windowId: number, visible: boolean): boolean {
    const handle = this.controlWindows.get(windowId);
    if (!handle) return false;
    if (visible) handle.window.show();
    else handle.window.hide();
    return true;
  }

  closeAllControlWindows(): void {
    for (const handle of this.controlWindows.values()) {
      try {
        if (!handle.window.isDestroyed()) handle.window.close();
      } catch {
        // already destroyed
      }
    }
    this.controlWindows.clear();
  }

  listAppHosts(): Array<{
    windowId: number;
    appSlug: string;
    experienceSlug: string;
    displayId: number;
  }> {
    return Array.from(this.appHosts.values()).map((h) => ({
      windowId: h.id,
      appSlug: h.appSlug,
      experienceSlug: h.experienceSlug,
      displayId: h.displayId,
    }));
  }

  private endExperience(
    appSlug: string,
    experienceSlug: string,
    exceptWindowId?: number,
  ): void {
    if (this.shuttingDown) return;

    const key = `${appSlug}:${experienceSlug}`;
    if (this.endingExperiences.has(key)) return;
    this.endingExperiences.add(key);

    const toDestroy: BrowserWindow[] = [];

    for (const [id, h] of this.appHosts.entries()) {
      if (h.appSlug !== appSlug || h.experienceSlug !== experienceSlug) continue;
      this.appHosts.delete(id);
      if (!h.window.isDestroyed()) toDestroy.push(h.window);
    }

    for (const [id, h] of this.controlWindows.entries()) {
      if (h.appSlug !== appSlug || h.experienceSlug !== experienceSlug) continue;
      this.controlWindows.delete(id);
      if (id === exceptWindowId) continue;
      if (!h.window.isDestroyed()) toDestroy.push(h.window);
    }

    for (const w of toDestroy) {
      try {
        w.destroy();
      } catch {
        // already destroyed
      }
    }

    this.stopExperienceOnServer(appSlug, experienceSlug);
    this.notifyExperienceEnded(appSlug, experienceSlug);
    this.endingExperiences.delete(key);
  }

  private hasControlFor(appSlug: string, experienceSlug: string): boolean {
    for (const w of this.controlWindows.values()) {
      if (w.appSlug === appSlug && w.experienceSlug === experienceSlug) return true;
    }
    return false;
  }

  private stopExperienceOnServer(appSlug: string, experienceSlug: string): void {
    if (this.shuttingDown) return;
    void fetch(`${this.serverBaseUrl}/v1/experiences/stop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appSlug, experienceSlug }),
    }).catch(() => undefined);
  }

  private notifyExperienceEnded(appSlug: string, experienceSlug: string): void {
    const dash = this.dashboard;
    if (!dash || dash.isDestroyed()) return;
    dash.webContents.send(IPC_CHANNELS.ExperienceEnded, { appSlug, experienceSlug });
  }

  private findDisplay(id: number | undefined): Display {
    const displays = screen.getAllDisplays();
    if (id !== undefined) {
      const found = displays.find((d) => d.id === id);
      if (found) return found;
    }
    return screen.getPrimaryDisplay();
  }

  private summarizeDisplay(d: Display): DisplaySummary {
    return {
      id: d.id,
      label: d.label || `Display ${d.id}`,
      bounds: d.bounds,
      workArea: d.workArea,
      scaleFactor: d.scaleFactor,
      primary: d.id === screen.getPrimaryDisplay().id,
      internal: d.internal,
    };
  }
}
