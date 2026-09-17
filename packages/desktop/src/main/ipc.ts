import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { isValidSlug } from '@gosai/shared/slug';
import type { CalibrationOrchestrator } from './calibration.js';
import type { WindowRegistry } from './windows.js';
import { IPC_CHANNELS } from './channels.js';

export { IPC_CHANNELS };

export interface IpcContext {
  readonly windows: WindowRegistry;
  readonly calibration: CalibrationOrchestrator;
}

/**
 * Every channel is for the dashboard only. Each handler checks that the
 * sender is the dashboard's main frame and validates its arguments before
 * touching a window.
 */
export function registerIpc(ctx: IpcContext): void {
  const handle = (channel: string, handler: (args: Args) => unknown): void => {
    ipcMain.handle(channel, (event: IpcMainInvokeEvent, raw: unknown) => {
      if (!ctx.windows.isDashboardFrame(event.senderFrame)) {
        throw new Error(`${channel} is only available to the dashboard`);
      }
      return handler(new Args(channel, raw));
    });
  };

  handle(IPC_CHANNELS.Displays, () => ({
    displays: ctx.windows.listDisplays(),
    primary: ctx.windows.primaryDisplay(),
  }));

  handle(IPC_CHANNELS.AppHostOpen, (args) => {
    const handle = ctx.windows.openAppHost({
      displayId: args.integer('displayId'),
      appSlug: args.slug('appSlug'),
      experienceSlug: args.string('experienceSlug'),
      ...args.optional('fullscreen', (key) => args.boolean(key)),
    });
    return {
      windowId: handle.id,
      displayId: handle.displayId,
      appSlug: handle.appSlug,
      experienceSlug: handle.experienceSlug,
    };
  });

  handle(IPC_CHANNELS.AppHostClose, (args) => ctx.windows.closeAppHost(args.integer('windowId')));

  handle(IPC_CHANNELS.AppHostList, () => ctx.windows.listAppHosts());

  handle(IPC_CHANNELS.ExperienceEnd, (args) => {
    ctx.windows.endExperience(args.slug('appSlug'), args.string('experienceSlug'));
    return { ok: true };
  });

  // Resolves when the flow ends, with its result. Main opens and closes the windows.
  handle(IPC_CHANNELS.CalibrationRun, (args) =>
    ctx.calibration.run({
      appSlug: args.slug('appSlug'),
      ...args.optional('displayId', (key) => args.integer(key)),
    }),
  );
}

const MAX_STRING_LENGTH = 256;

/** Reads typed fields from an IPC argument object, throwing on bad input. */
class Args {
  private readonly values: Record<string, unknown>;

  constructor(
    private readonly channel: string,
    raw: unknown,
  ) {
    this.values = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  }

  string(key: string): string {
    const value = this.values[key];
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_STRING_LENGTH) {
      throw this.invalid(key);
    }
    return value;
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

  boolean(key: string): boolean {
    const value = this.values[key];
    if (typeof value !== 'boolean') throw this.invalid(key);
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
