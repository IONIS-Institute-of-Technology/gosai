/**
 * Frameless status window shown while GOSAI boots: Python runtime install on
 * first launch, then the server start. Kiosks also use it to show boot
 * failures, since they have no dashboard and may run unattended.
 */

import { BrowserWindow } from 'electron';

const SPLASH_HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      html, body {
        margin: 0; height: 100%;
        background: #0a0a0a; color: #d4d4d4;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        display: flex; align-items: center; justify-content: center;
        overflow: hidden; user-select: none;
      }
      .box { text-align: center; padding: 0 32px; max-width: 100%; }
      .title { font-size: 15px; color: #fafafa; letter-spacing: 0.08em; }
      .spinner {
        margin: 18px auto; width: 22px; height: 22px;
        border: 2px solid #262626; border-top-color: #fafafa;
        border-radius: 50%; animation: spin 0.9s linear infinite;
      }
      @keyframes spin { to { transform: rotate(360deg); } }
      #status {
        font-size: 11px; color: #737373; min-height: 2.6em;
        overflow-wrap: anywhere; white-space: pre-wrap;
      }
      body.error .spinner, body.warning .spinner { display: none; }
      body.error .title { color: #f87171; margin-bottom: 14px; }
      body.error #status { color: #fca5a5; }
      body.warning .title { color: #fbbf24; margin-bottom: 14px; }
      body.warning #status { color: #fde68a; }
    </style>
  </head>
  <body>
    <div class="box">
      <div class="title" id="title">GOSAI</div>
      <div class="spinner"></div>
      <div id="status">Starting…</div>
    </div>
  </body>
</html>`;

type SplashTone = 'status' | 'warning' | 'error';

interface SplashState {
  readonly tone: SplashTone;
  readonly title: string;
  readonly message: string;
}

export class SplashWindow {
  private window: BrowserWindow | null = null;
  private loaded = false;
  private state: SplashState = { tone: 'status', title: 'GOSAI', message: 'Starting…' };

  show(): void {
    if (this.window && !this.window.isDestroyed()) return;
    const win = new BrowserWindow({
      width: 520,
      height: 240,
      frame: false,
      resizable: false,
      alwaysOnTop: true,
      backgroundColor: '#0a0a0a',
      show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    win.once('ready-to-show', () => win.show());
    win.webContents.on('did-finish-load', () => {
      this.loaded = true;
      this.render();
    });
    void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(SPLASH_HTML)}`);
    this.window = win;
  }

  setStatus(message: string): void {
    this.update({ tone: 'status', title: 'GOSAI', message });
  }

  /** A problem GOSAI continues after, e.g. the Python drivers being unavailable. */
  showWarning(title: string, message: string): void {
    this.update({ tone: 'warning', title, message });
  }

  showError(title: string, message: string): void {
    this.update({ tone: 'error', title, message });
  }

  close(): void {
    const win = this.window;
    this.window = null;
    this.loaded = false;
    if (win && !win.isDestroyed()) win.destroy();
  }

  private update(state: SplashState): void {
    this.state = state;
    this.show();
    this.render();
  }

  private render(): void {
    const win = this.window;
    if (!win || win.isDestroyed() || !this.loaded) return;
    const { tone, title, message } = this.state;
    const script =
      `document.body.className = ${JSON.stringify(tone)};` +
      `document.getElementById('title').textContent = ${JSON.stringify(title)};` +
      `document.getElementById('status').textContent = ${JSON.stringify(message)};`;
    void win.webContents.executeJavaScript(script).catch(() => undefined);
  }
}
