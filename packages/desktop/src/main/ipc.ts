import { ipcMain } from 'electron';
import type { WindowRegistry } from './windows.js';
import { IPC_CHANNELS } from './channels.js';

export { IPC_CHANNELS };

export interface IpcContext {
  readonly windows: WindowRegistry;
}

export function registerIpc(ctx: IpcContext): void {
  ipcMain.handle(IPC_CHANNELS.Displays, () => ({
    displays: ctx.windows.listDisplays(),
    primary: ctx.windows.primaryDisplay(),
  }));

  ipcMain.handle(
    IPC_CHANNELS.AppHostOpen,
    (
      _ev,
      args: { displayId: number; appSlug: string; experienceSlug: string; fullscreen?: boolean },
    ) => {
      const handle = ctx.windows.openAppHost(args);
      return {
        windowId: handle.id,
        displayId: handle.displayId,
        appSlug: handle.appSlug,
        experienceSlug: handle.experienceSlug,
      };
    },
  );

  ipcMain.handle(IPC_CHANNELS.AppHostClose, (_ev, args: { windowId: number }) => {
    return ctx.windows.closeAppHost(args.windowId);
  });

  ipcMain.handle(IPC_CHANNELS.AppHostList, () => ctx.windows.listAppHosts());

  ipcMain.handle(
    IPC_CHANNELS.ExperienceEnd,
    (_ev, args: { appSlug: string; experienceSlug: string }) => {
      ctx.windows.endExperience(args.appSlug, args.experienceSlug);
      return { ok: true };
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.ControlWindowOpen,
    (
      _ev,
      args: {
        appSlug: string;
        experienceSlug: string;
        projectorDisplayId?: number;
        width?: number;
        height?: number;
        title?: string;
      },
    ) => {
      const handle = ctx.windows.openControlWindow(args);
      return {
        windowId: handle.id,
        appSlug: handle.appSlug,
        experienceSlug: handle.experienceSlug,
      };
    },
  );

  ipcMain.handle(IPC_CHANNELS.ControlWindowClose, (_ev, args: { windowId: number }) => {
    return ctx.windows.closeControlWindow(args.windowId);
  });

  ipcMain.handle(IPC_CHANNELS.ControlWindowHide, (_ev, args: { windowId: number }) => {
    return ctx.windows.setControlWindowVisible(args.windowId, false);
  });

  ipcMain.handle(IPC_CHANNELS.ControlWindowShow, (_ev, args: { windowId: number }) => {
    return ctx.windows.setControlWindowVisible(args.windowId, true);
  });
}
