import { contextBridge, ipcRenderer } from 'electron';
import { createDashboardApi, type IpcTransport } from './api.js';

const transport: IpcTransport = {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  on: (channel, listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown): void =>
      listener(payload as Parameters<typeof listener>[0]);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.off(channel, handler);
  },
};

contextBridge.exposeInMainWorld(
  'gosai',
  createDashboardApi(transport, { version: '0.1.0', platform: process.platform }),
);
