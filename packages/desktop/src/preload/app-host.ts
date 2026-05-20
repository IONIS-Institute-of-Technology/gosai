import { contextBridge } from 'electron';

const api = {
  version: '0.1.0',
  platform: process.platform,
};

contextBridge.exposeInMainWorld('gosaiApp', api);

export type AppHostApi = typeof api;
