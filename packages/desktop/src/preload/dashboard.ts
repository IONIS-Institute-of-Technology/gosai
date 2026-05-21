import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '../main/channels.js';

interface DisplaySummary {
  id: number;
  label: string;
  bounds: { x: number; y: number; width: number; height: number };
  workArea: { x: number; y: number; width: number; height: number };
  scaleFactor: number;
  primary: boolean;
  internal: boolean;
}

const api = {
  version: '0.1.0',
  platform: process.platform,

  displays: {
    list: () =>
      ipcRenderer.invoke(IPC_CHANNELS.Displays) as Promise<{
        displays: DisplaySummary[];
        primary: DisplaySummary;
      }>,
  },

  appHost: {
    open: (args: {
      displayId: number;
      appSlug: string;
      experienceSlug: string;
      fullscreen?: boolean;
    }) =>
      ipcRenderer.invoke(IPC_CHANNELS.AppHostOpen, args) as Promise<{
        windowId: number;
        displayId: number;
        appSlug: string;
        experienceSlug: string;
      }>,
    close: (windowId: number) =>
      ipcRenderer.invoke(IPC_CHANNELS.AppHostClose, { windowId }) as Promise<boolean>,
    list: () =>
      ipcRenderer.invoke(IPC_CHANNELS.AppHostList) as Promise<
        Array<{ windowId: number; appSlug: string; experienceSlug: string; displayId: number }>
      >,
  },

  experience: {
    end: (args: { appSlug: string; experienceSlug: string }) =>
      ipcRenderer.invoke(IPC_CHANNELS.ExperienceEnd, args) as Promise<{ ok: true }>,
  },

  controlWindow: {
    open: (args: {
      appSlug: string;
      experienceSlug: string;
      projectorDisplayId?: number;
      width?: number;
      height?: number;
      title?: string;
    }) =>
      ipcRenderer.invoke(IPC_CHANNELS.ControlWindowOpen, args) as Promise<{
        windowId: number;
        appSlug: string;
        experienceSlug: string;
      }>,
    close: (windowId: number) =>
      ipcRenderer.invoke(IPC_CHANNELS.ControlWindowClose, { windowId }) as Promise<boolean>,
    hide: (windowId: number) =>
      ipcRenderer.invoke(IPC_CHANNELS.ControlWindowHide, { windowId }) as Promise<boolean>,
    show: (windowId: number) =>
      ipcRenderer.invoke(IPC_CHANNELS.ControlWindowShow, { windowId }) as Promise<boolean>,
  },

  onExperienceEnded: (
    listener: (payload: { appSlug: string; experienceSlug: string }) => void,
  ) => {
    const channel = IPC_CHANNELS.ExperienceEnded;
    const handler = (
      _ev: Electron.IpcRendererEvent,
      payload: { appSlug: string; experienceSlug: string },
    ): void => listener(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.off(channel, handler);
  },
};

contextBridge.exposeInMainWorld('gosai', api);

export type DashboardApi = typeof api;
