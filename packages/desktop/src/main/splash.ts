/**
 * Minimal frameless status window shown while the first-launch Python
 * runtime installation runs, so a kiosk machine never sits on a black screen
 * for minutes without feedback.
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
        overflow-wrap: anywhere;
      }
    </style>
  </head>
  <body>
    <div class="box">
      <div class="title">GOSAI</div>
      <div class="spinner"></div>
      <div id="status">Starting…</div>
    </div>
  </body>
</html>`;

export class SplashWindow {
  private window: BrowserWindow | null = null;

  show(): void {
    if (this.window && !this.window.isDestroyed()) return;
    const win = new BrowserWindow({
      width: 460,
      height: 220,
      frame: false,
      resizable: false,
      alwaysOnTop: true,
      backgroundColor: '#0a0a0a',
      show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    win.once('ready-to-show', () => win.show());
    void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(SPLASH_HTML)}`);
    this.window = win;
  }

  setStatus(message: string): void {
    const win = this.window;
    if (!win || win.isDestroyed()) return;
    void win.webContents
      .executeJavaScript(
        `document.getElementById('status').textContent = ${JSON.stringify(message)};`,
      )
      .catch(() => undefined);
  }

  close(): void {
    const win = this.window;
    this.window = null;
    if (win && !win.isDestroyed()) win.destroy();
  }
}
