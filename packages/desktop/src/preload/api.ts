/**
 * Builds the dashboard API from an IPC transport. No Electron import, so
 * tests can check each method against the contract.
 */

import type {
  DashboardApi,
  IpcArgs,
  IpcEventChannel,
  IpcEventChannels,
  IpcInvokeChannel,
  IpcResult,
} from '../ipc-contract.js';

export interface IpcTransport {
  invoke<C extends IpcInvokeChannel>(channel: C, ...args: IpcArgs<C>): Promise<IpcResult<C>>;
  /** Returns a function that removes the listener. */
  on<C extends IpcEventChannel>(
    channel: C,
    listener: (payload: IpcEventChannels[C]) => void,
  ): () => void;
}

export function createDashboardApi(
  ipc: IpcTransport,
  info: { readonly version: string; readonly platform: string },
): DashboardApi {
  return {
    version: info.version,
    platform: info.platform,
    displays: {
      list: () => ipc.invoke('gosai:displays:list'),
      onChanged: (listener) => ipc.on('gosai:displays-changed', listener),
    },
    windows: {
      list: () => ipc.invoke('gosai:windows:list'),
      onChanged: (listener) => ipc.on('gosai:windows-changed', listener),
    },
    calibration: {
      run: (args) => ipc.invoke('gosai:calibration:run', args),
    },
  };
}
