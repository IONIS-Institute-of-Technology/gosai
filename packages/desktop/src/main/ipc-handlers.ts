/**
 * The IPC handlers, one per channel of the contract. Arguments come from the
 * renderer, so each handler validates them. No Electron import, so tests can
 * call the handlers.
 */

import { isValidSlug } from '@gosai/shared/slug';
import type { IpcInvokeChannel, IpcInvokeChannels, IpcResult } from '../ipc-contract.js';
import type { CalibrationOrchestrator } from './calibration.js';
import type { WindowRegistry } from './windows.js';

export interface IpcHandlerContext {
  readonly windows: Pick<WindowRegistry, 'displayList' | 'listWindows'>;
  readonly calibration: Pick<CalibrationOrchestrator, 'run'>;
}

type Unchecked<T extends readonly unknown[]> = { [K in keyof T]: unknown };

/** Handlers take the raw arguments, which the renderer may have sent wrong. */
export type IpcHandlers = {
  readonly [C in IpcInvokeChannel]: (
    ...args: Unchecked<IpcInvokeChannels[C]['args']>
  ) => IpcResult<C> | Promise<IpcResult<C>>;
};

export function createIpcHandlers(ctx: IpcHandlerContext): IpcHandlers {
  return {
    'gosai:displays:list': () => ctx.windows.displayList(),
    'gosai:windows:list': () => ctx.windows.listWindows(),
    'gosai:calibration:run': (raw) => {
      const args = new Args('gosai:calibration:run', raw);
      return ctx.calibration.run({
        appSlug: args.slug('appSlug'),
        ...args.optional('displayId', (key) => args.integer(key)),
      });
    },
  };
}

/** Reads typed fields from an IPC argument object, throwing on bad input. */
export class Args {
  private readonly values: Record<string, unknown>;

  constructor(
    private readonly channel: string,
    raw: unknown,
  ) {
    this.values = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  }

  slug(key: string): string {
    const value = this.values[key];
    if (!isValidSlug(value)) throw this.invalid(key);
    return value;
  }

  integer(key: string): number {
    const value = this.values[key];
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw this.invalid(key);
    return value;
  }

  /** `{ [key]: read(key) }` when the field is present, `{}` otherwise. */
  optional<K extends string, T>(key: K, read: (key: K) => T): { [P in K]?: T } {
    if (this.values[key] === undefined) return {};
    return { [key]: read(key) } as { [P in K]?: T };
  }

  private invalid(key: string): Error {
    return new Error(`${this.channel}: invalid ${key}`);
  }
}
