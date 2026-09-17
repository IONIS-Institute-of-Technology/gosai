import {
  app,
  BrowserWindow,
  powerSaveBlocker,
  screen,
  type Display,
  type WebContents,
  type WebFrameMain,
} from 'electron';
import { join } from 'node:path';
import type { DisplayInfo } from '@gosai/shared';
import { appHostname } from '@gosai/shared/app-origin';
import { mintAppToken } from '@gosai/shared/auth';
import { ServerClient } from '@gosai/shared/client';
import type {
  AppWindowInfo,
  DisplayList,
  IpcEventChannel,
  IpcEventChannels,
} from '../ipc-contract.js';
import { dashboardContentSecurityPolicy } from './dashboard-csp.js';

interface WindowRegistryOptions {
  readonly rootDir: string;
  /** Dashboard token for this launch. App window tokens derive from it. */
  readonly dashboardToken: string;
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

export interface OpenAppHostOptions {
  readonly displayId: number;
  readonly appSlug: string;
  readonly experienceSlug: string;
  readonly fullscreen?: boolean;
  readonly targetAppSlug?: string;
  readonly driverBinding?: string;
}

export interface OpenControlWindowOptions {
  readonly appSlug: string;
  readonly experienceSlug: string;
  readonly targetAppSlug?: string;
  readonly driverBinding?: string;
  readonly width?: number;
  readonly height?: number;
  readonly title?: string;
}

/** The Vite dev server that serves the dashboard under `electron-vite dev`. */
const devRendererUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined;
const isMac = process.platform === 'darwin';
const isLinux = process.platform === 'linux';

/** Server bind addresses that `<slug>.localhost` (always loopback) can reach. */
const LOOPBACK_REACHABLE_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '0.0.0.0', '::']);

/** How long an app window gets to stop its experience before it is destroyed. */
const APP_STOP_TIMEOUT_MS = 3000;

/** Web preferences shared by the windows that run app code. */
const APP_WEB_PREFERENCES = {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  backgroundThrottling: false,
  // Kiosks are driven by gestures and may never get a click, so audio must
  // start without one.
  autoplayPolicy: 'no-user-gesture-required',
} as const;

export class WindowRegistry {
  private dashboard: BrowserWindow | null = null;
  private readonly appHosts = new Map<number, AppHostHandle>();
  private readonly controlWindows = new Map<number, ControlWindowHandle>();
  private readonly endingExperiences = new Set<string>();
  private powerSaveBlockerId: number | null = null;
  private shuttingDown = false;
  private displayEventsInstalled = false;
  private serverHost = '127.0.0.1';
  private serverPort = 7777;
  /** Created on first use, so the dashboard token only goes to a known server address. */
  private client: ServerClient | null = null;

  constructor(private readonly options: WindowRegistryOptions) {}

  /**
   * Points every window opened from now on, and main's own connection, at the
   * given server. Called with the embedded server's ephemeral port, or the
   * port of a server started separately in development.
   */
  setServerAddress(addr: { host: string; port: number }): void {
    this.serverHost = addr.host;
    this.serverPort = addr.port;
    if (!LOOPBACK_REACHABLE_HOSTS.has(addr.host)) {
      console.warn(
        `[gosai-desktop] the server listens on ${addr.host}, but app windows connect through ` +
          '<slug>.localhost, which resolves to loopback; they will not reach it',
      );
    }
    this.client?.close();
    this.client = null;
  }

  /** Main's connection to the server, with the dashboard token. */
  get server(): ServerClient {
    this.client ??= this.connectClient();
    return this.client;
  }

  private connectClient(): ServerClient {
    const client = new ServerClient({
      url: `ws://${this.serverHost}:${this.serverPort}/ws`,
      token: this.options.dashboardToken,
    });
    client.onError((err, context) => console.error(`[gosai-desktop] ${context} failed`, err));
    client.connect();
    return client;
  }

  get serverBaseUrl(): string {
    return `http://${this.serverHost}:${this.serverPort}`;
  }

  /** Query params the dashboard needs to find and authenticate with the server. */
  private appendServerParams(query: URLSearchParams, token: string): URLSearchParams {
    query.set('serverHost', this.serverHost);
    query.set('serverPort', String(this.serverPort));
    query.set('token', token);
    return query;
  }

  /**
   * URL of the host page for an app window, on the app's own origin
   * `http://<slug>.localhost:<port>/`. Browsers resolve `*.localhost` to
   * loopback, so `serverHost` isn't used: the server must listen on a
   * loopback or wildcard address, which desktop and kiosk always do.
   */
  private appHostUrl(appSlug: string, launch: Record<string, string | undefined>): string {
    const url = new URL(`http://${appHostname(appSlug)}:${this.serverPort}/`);
    for (const [key, value] of Object.entries(launch)) {
      if (value !== undefined) url.searchParams.set(key, value);
    }
    return url.toString();
  }

  /**
   * Asks the page to stop its experience, waits for it up to
   * APP_STOP_TIMEOUT_MS, then destroys the window. `destroy()` skips the
   * page's unload handlers, so without this the experience's stop hook
   * would never run.
   */
  private async stopAndDestroy(win: BrowserWindow): Promise<void> {
    if (win.isDestroyed()) return;
    win.hide();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, APP_STOP_TIMEOUT_MS);
    });
    const stopped = win.webContents
      .executeJavaScript('globalThis.gosaiHost?.stop()')
      .then(() => undefined)
      .catch(() => undefined);
    await Promise.race([stopped, timeout]);
    clearTimeout(timer);
    if (!win.isDestroyed()) win.destroy();
  }

  /**
   * Token for an app window: scoped to the app, plus the driver binding and
   * target app it was opened with. The calibration runner uses its target's
   * camera, and saves the target's calibration profile when its manifest
   * requests `calibration:write`.
   */
  private appToken(opts: {
    appSlug: string;
    targetAppSlug?: string | undefined;
    driverBinding?: string | undefined;
  }): string {
    return mintAppToken(this.options.dashboardToken, opts.appSlug, {
      driverBinding: opts.driverBinding,
      target: opts.targetAppSlug,
    });
  }

  /** True when `frame` is the dashboard's top-level frame showing the dashboard page. */
  isDashboardFrame(frame: WebFrameMain | null | undefined): boolean {
    const dashboard = this.dashboard;
    if (!frame || !dashboard || dashboard.isDestroyed()) return false;
    try {
      const main = dashboard.webContents.mainFrame;
      if (frame.processId !== main.processId || frame.routingId !== main.routingId) return false;
      return new URL(frame.url).pathname.endsWith('/dashboard.html');
    } catch {
      return false;
    }
  }

  /** True for app-host and control windows, which run app code. */
  isAppWindow(contents: WebContents): boolean {
    for (const handle of [...this.appHosts.values(), ...this.controlWindows.values()]) {
      if (!handle.window.isDestroyed() && handle.window.webContents.id === contents.id) {
        return true;
      }
    }
    return false;
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
        sandbox: true,
      },
    });

    win.once('ready-to-show', () => win.show());
    this.installDashboardPolicy(win);
    this.installDisplayEvents();

    const query = this.appendServerParams(new URLSearchParams(), this.options.dashboardToken);
    if (devRendererUrl) {
      void win.loadURL(`${devRendererUrl}/dashboard.html?${query.toString()}`);
    } else {
      void win.loadFile(join(this.options.rootDir, '../renderer/dashboard.html'), {
        search: `?${query.toString()}`,
      });
    }

    win.on('closed', () => {
      if (this.dashboard === win) this.dashboard = null;
      app.quit();
    });

    this.dashboard = win;
    return win;
  }

  /**
   * Sets the dashboard's Content-Security-Policy as a response header, since
   * the server's port is only known at runtime. Covers `file://` loads too.
   */
  private installDashboardPolicy(win: BrowserWindow): void {
    const contents = win.webContents;
    contents.session.webRequest.onHeadersReceived((details, callback) => {
      if (details.webContentsId !== contents.id || details.resourceType !== 'mainFrame') {
        callback({});
        return;
      }
      const policy = dashboardContentSecurityPolicy({
        server: { host: this.serverHost, port: this.serverPort },
        ...(devRendererUrl ? { devServerUrl: devRendererUrl } : {}),
      });
      const headers = Object.fromEntries(
        Object.entries(details.responseHeaders ?? {}).filter(
          ([name]) => name.toLowerCase() !== 'content-security-policy',
        ),
      );
      callback({ responseHeaders: { ...headers, 'Content-Security-Policy': [policy] } });
    });
  }

  private installDisplayEvents(): void {
    if (this.displayEventsInstalled) return;
    this.displayEventsInstalled = true;
    const changed = (): void => this.sendToDashboard('gosai:displays-changed', this.displayList());
    screen.on('display-added', changed);
    screen.on('display-removed', changed);
    screen.on('display-metrics-changed', changed);
  }

  private sendToDashboard<C extends IpcEventChannel>(
    channel: C,
    payload: IpcEventChannels[C],
  ): void {
    const dashboard = this.dashboard;
    if (!dashboard || dashboard.isDestroyed()) return;
    dashboard.webContents.send(channel, payload);
  }

  listDisplays(): DisplayInfo[] {
    return screen.getAllDisplays().map((d) => this.summarizeDisplay(d));
  }

  primaryDisplay(): DisplayInfo {
    return this.summarizeDisplay(screen.getPrimaryDisplay());
  }

  displayList(): DisplayList {
    return { displays: this.listDisplays(), primary: this.primaryDisplay() };
  }

  openAppHost(opts: OpenAppHostOptions): AppHostHandle {
    // Mint first: it rejects invalid slugs before a window exists.
    const token = this.appToken(opts);
    const display = this.findDisplay(opts.displayId);
    const bounds = display.bounds;
    const wantsFullscreen = opts.fullscreen ?? true;

    const win = new BrowserWindow({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      frame: false,
      // On Linux, compositors ignore (x, y) when fullscreen is requested at
      // creation. On macOS, creation-time fullscreen plus setKiosk() on show
      // makes the window drop out of fullscreen on the first open.
      fullscreen: wantsFullscreen && !isLinux && !isMac,
      backgroundColor: '#000000',
      autoHideMenuBar: true,
      show: false,
      webPreferences: APP_WEB_PREFERENCES,
    });

    let shown = false;
    let fallbackTimer: NodeJS.Timeout | undefined;
    const showWindow = (): void => {
      if (shown || win.isDestroyed()) return;
      shown = true;
      if (fallbackTimer) clearTimeout(fallbackTimer);

      if (wantsFullscreen && isMac) {
        win.setBounds(bounds);
      }

      win.show();

      if (!wantsFullscreen) {
        win.focus();
        return;
      }

      if (isMac) {
        win.focus();
        setImmediate(() => {
          if (win.isDestroyed()) return;
          win.setFullScreen(true);
          win.setKiosk(true);
          win.focus();
        });
        return;
      }

      if (!isLinux) {
        win.focus();
        win.setKiosk(true);
        return;
      }

      // Linux / XWayland: reapply bounds on the now-mapped window so the X
      // server moves it to the target display, then enter fullscreen there.
      win.setBounds(bounds);
      win.focus();
      setTimeout(() => {
        if (win.isDestroyed()) return;
        win.setFullScreen(true);
        setTimeout(() => {
          if (win.isDestroyed() || win.isFullScreen()) return;
          win.maximize();
          win.focus();
        }, 500);
      }, 200);
    };

    win.once('ready-to-show', showWindow);
    win.webContents.once('did-finish-load', showWindow);
    fallbackTimer = setTimeout(showWindow, 3000);

    void win.loadURL(
      this.appHostUrl(opts.appSlug, {
        experience: opts.experienceSlug,
        display: String(display.id),
        target: opts.targetAppSlug,
        driverBinding: opts.driverBinding,
        token,
      }),
    );

    const handle: AppHostHandle = {
      id: win.id,
      window: win,
      displayId: display.id,
      appSlug: opts.appSlug,
      experienceSlug: opts.experienceSlug,
    };

    this.appHosts.set(handle.id, handle);
    this.windowsChanged();
    // A close from the window manager stops the experience like main's own close.
    win.on('close', (event) => {
      event.preventDefault();
      void this.stopAndDestroy(win);
    });
    win.on('closed', () => {
      if (!this.appHosts.delete(handle.id)) return;
      this.windowsChanged();
      if (this.hasControlFor(opts.appSlug, opts.experienceSlug)) return;
      this.stopExperienceOnServer(opts.appSlug, opts.experienceSlug);
    });

    return handle;
  }

  /** Stops and closes every app-host window. */
  async closeAllAppHosts(): Promise<void> {
    const windows = [...this.appHosts.values()].map((handle) => handle.window);
    this.appHosts.clear();
    this.windowsChanged();
    await Promise.all(windows.map((win) => this.stopAndDestroy(win)));
  }

  openControlWindow(opts: OpenControlWindowOptions): ControlWindowHandle {
    const token = this.appToken(opts);
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
      webPreferences: APP_WEB_PREFERENCES,
    });

    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

    win.once('ready-to-show', () => {
      win.show();
      win.focus();
    });

    void win.loadURL(
      this.appHostUrl(opts.appSlug, {
        experience: opts.experienceSlug,
        role: 'control',
        target: opts.targetAppSlug,
        driverBinding: opts.driverBinding,
        token,
      }),
    );

    const handle: ControlWindowHandle = {
      id: win.id,
      window: win,
      appSlug: opts.appSlug,
      experienceSlug: opts.experienceSlug,
    };

    this.controlWindows.set(handle.id, handle);
    this.windowsChanged();
    // Closing the control window ends the experience; every window of it,
    // this one included, stops before it is destroyed.
    win.on('close', (event) => {
      if (this.shuttingDown) return;
      event.preventDefault();
      this.endExperience(opts.appSlug, opts.experienceSlug);
    });

    return handle;
  }

  /** Stops and closes every control window. */
  async closeAllControlWindows(): Promise<void> {
    const windows = [...this.controlWindows.values()].map((handle) => handle.window);
    this.controlWindows.clear();
    this.windowsChanged();
    await Promise.all(windows.map((win) => this.stopAndDestroy(win)));
  }

  listWindows(): AppWindowInfo[] {
    return [
      ...Array.from(this.appHosts.values(), (h) => ({
        windowId: h.id,
        appSlug: h.appSlug,
        experienceSlug: h.experienceSlug,
        role: 'app' as const,
        displayId: h.displayId,
      })),
      ...Array.from(this.controlWindows.values(), (h) => ({
        windowId: h.id,
        appSlug: h.appSlug,
        experienceSlug: h.experienceSlug,
        role: 'control' as const,
        displayId: null,
      })),
    ];
  }

  /** Experiences with at least one open window. */
  openExperiences(): Array<{ appSlug: string; experienceSlug: string }> {
    return this.listWindows().map(({ appSlug, experienceSlug }) => ({ appSlug, experienceSlug }));
  }

  /**
   * Stops and closes the experience's windows, then stops the experience on
   * the server once they are gone, so its stop hooks run while its drivers
   * still do.
   */
  endExperience(appSlug: string, experienceSlug: string): void {
    if (this.shuttingDown) return;
    const key = `${appSlug}:${experienceSlug}`;
    if (this.endingExperiences.has(key)) return;
    this.endingExperiences.add(key);
    void this.closeExperienceWindowsNow(appSlug, experienceSlug).then(() => {
      this.stopExperienceOnServer(appSlug, experienceSlug);
      this.endingExperiences.delete(key);
    });
  }

  /** Stops and closes the experience's windows, for an experience the server already stopped. */
  closeExperienceWindows(appSlug: string, experienceSlug: string): void {
    if (this.shuttingDown) return;
    void this.closeExperienceWindowsNow(appSlug, experienceSlug);
  }

  private async closeExperienceWindowsNow(appSlug: string, experienceSlug: string): Promise<void> {
    const toDestroy: BrowserWindow[] = [];
    for (const handles of [this.appHosts, this.controlWindows]) {
      for (const [id, h] of handles.entries()) {
        if (h.appSlug !== appSlug || h.experienceSlug !== experienceSlug) continue;
        handles.delete(id);
        toDestroy.push(h.window);
      }
    }
    if (toDestroy.length === 0) return;
    this.windowsChanged();
    await Promise.all(toDestroy.map((w) => this.stopAndDestroy(w)));
  }

  private hasControlFor(appSlug: string, experienceSlug: string): boolean {
    for (const w of this.controlWindows.values()) {
      if (w.appSlug === appSlug && w.experienceSlug === experienceSlug) return true;
    }
    return false;
  }

  private stopExperienceOnServer(appSlug: string, experienceSlug: string): void {
    if (this.shuttingDown) return;
    const client = this.server;
    void (async () => {
      try {
        await client.ready(5_000);
        await client.request('experience:stop', { appSlug, experienceSlug });
      } catch (err) {
        console.error(`[gosai-desktop] could not stop ${appSlug}/${experienceSlug}`, err);
      }
    })();
  }

  /** Updates the power save blocker and tells the dashboard. */
  private windowsChanged(): void {
    this.updatePowerSaveBlocker();
    this.sendToDashboard('gosai:windows-changed', this.listWindows());
  }

  private updatePowerSaveBlocker(): void {
    const hasActiveAppWindow = this.appHosts.size > 0 || this.controlWindows.size > 0;

    if (hasActiveAppWindow) {
      if (this.powerSaveBlockerId !== null && powerSaveBlocker.isStarted(this.powerSaveBlockerId)) {
        return;
      }
      this.powerSaveBlockerId = powerSaveBlocker.start('prevent-display-sleep');
      return;
    }

    if (this.powerSaveBlockerId === null) return;
    powerSaveBlocker.stop(this.powerSaveBlockerId);
    this.powerSaveBlockerId = null;
  }

  private findDisplay(id: number | undefined): Display {
    const displays = screen.getAllDisplays();
    if (id !== undefined) {
      const found = displays.find((d) => d.id === id);
      if (found) return found;
    }
    return screen.getPrimaryDisplay();
  }

  private summarizeDisplay(d: Display): DisplayInfo {
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
