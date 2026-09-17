/**
 * Default-deny rules for every web contents: no new windows, no navigation
 * away from the loaded page, no webviews and no permissions, except camera
 * and microphone access for windows that run app code.
 */

import { app, type WebContents } from 'electron';

export function installWebContentsGuards(isAppWindow: (contents: WebContents) => boolean): void {
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));

    contents.on('will-navigate', (event) => {
      // Reloading the current page (Vite's full reload in dev) is fine.
      if (stripHash(event.url) !== stripHash(contents.getURL())) event.preventDefault();
    });
    contents.on('will-attach-webview', (event) => event.preventDefault());

    contents.session.setPermissionRequestHandler((requester, permission, callback) => {
      callback(permission === 'media' && isAppWindow(requester));
    });
    contents.session.setPermissionCheckHandler((requester, permission) => {
      return permission === 'media' && requester !== null && isAppWindow(requester);
    });
  });
}

function stripHash(url: string): string {
  const hash = url.indexOf('#');
  return hash === -1 ? url : url.slice(0, hash);
}
