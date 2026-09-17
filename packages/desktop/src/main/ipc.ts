import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import type { IpcInvokeChannel } from '../ipc-contract.js';
import { createIpcHandlers, type IpcHandlerContext } from './ipc-handlers.js';
import type { WindowRegistry } from './windows.js';

export interface IpcContext extends IpcHandlerContext {
  readonly windows: WindowRegistry;
}

/**
 * Every channel is for the dashboard only. Each handler checks that the
 * sender is the dashboard's main frame before it reads its arguments.
 */
export function registerIpc(ctx: IpcContext): void {
  const handlers = createIpcHandlers(ctx);
  for (const channel of Object.keys(handlers) as IpcInvokeChannel[]) {
    const handler = handlers[channel] as (...args: unknown[]) => unknown;
    ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      if (!ctx.windows.isDashboardFrame(event.senderFrame)) {
        throw new Error(`${channel} is only available to the dashboard`);
      }
      return handler(...args);
    });
  }
}
