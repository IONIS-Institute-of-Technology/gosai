import { describe, expect, test } from 'bun:test';
import type {
  AppWindowInfo,
  DashboardApi,
  DisplayList,
  IpcArgs,
  IpcEventChannels,
  IpcInvokeChannel,
  IpcResult,
} from '../src/ipc-contract.js';
import { createIpcHandlers, type IpcHandlers } from '../src/main/ipc-handlers.js';
import { createDashboardApi, type IpcTransport } from '../src/preload/api.js';

/** Compile-time equality check: fails `bun run typecheck` when the types differ. */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
function assertType<T extends true>(): T | undefined {
  return undefined;
}

assertType<
  Equal<
    IpcArgs<'gosai:calibration:run'>,
    [{ readonly appSlug: string; readonly displayId?: number }]
  >
>();
assertType<Equal<IpcResult<'gosai:windows:list'>, readonly AppWindowInfo[]>>();
assertType<Equal<ReturnType<DashboardApi['displays']['list']>, Promise<DisplayList>>>();
assertType<Equal<Parameters<IpcHandlers['gosai:calibration:run']>, [unknown]>>();

const display = {
  id: 1,
  label: 'Built-in',
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1040 },
  scaleFactor: 1,
  primary: true,
  internal: true,
};

class RecordingTransport implements IpcTransport {
  readonly invoked: Array<{ channel: IpcInvokeChannel; args: unknown[] }> = [];
  readonly listeners = new Map<string, (payload: unknown) => void>();
  readonly handlers: IpcHandlers;

  constructor() {
    this.handlers = createIpcHandlers({
      windows: {
        displayList: () => ({ displays: [display], primary: display }),
        listWindows: () => [
          { windowId: 7, appSlug: 'pool', experienceSlug: 'main', role: 'app', displayId: 1 },
        ],
      },
      calibration: { run: async (options) => ({ ok: false, error: JSON.stringify(options) }) },
    });
  }

  invoke<C extends IpcInvokeChannel>(channel: C, ...args: IpcArgs<C>): Promise<IpcResult<C>> {
    this.invoked.push({ channel, args });
    const handler = this.handlers[channel] as (...raw: unknown[]) => unknown;
    return Promise.resolve(handler(...args)) as Promise<IpcResult<C>>;
  }

  on<C extends keyof IpcEventChannels>(
    channel: C,
    listener: (payload: IpcEventChannels[C]) => void,
  ): () => void {
    this.listeners.set(channel, listener as (payload: unknown) => void);
    return () => this.listeners.delete(channel);
  }
}

describe('IPC contract', () => {
  test('each API method invokes its channel and main answers it', async () => {
    const ipc = new RecordingTransport();
    const api = createDashboardApi(ipc, { version: '1.2.3', platform: 'linux' });

    expect(api.version).toBe('1.2.3');
    expect(await api.displays.list()).toEqual({ displays: [display], primary: display });
    expect(await api.windows.list()).toHaveLength(1);
    expect(await api.calibration.run({ appSlug: 'pool', displayId: 2 })).toEqual({
      ok: false,
      error: '{"appSlug":"pool","displayId":2}',
    });
    expect(ipc.invoked.map((call) => call.channel)).toEqual([
      'gosai:displays:list',
      'gosai:windows:list',
      'gosai:calibration:run',
    ]);
  });

  test('event channels reach listeners until they unsubscribe', () => {
    const ipc = new RecordingTransport();
    const api = createDashboardApi(ipc, { version: '1', platform: 'linux' });
    const seen: unknown[] = [];
    const off = api.windows.onChanged((windows) => seen.push(windows));
    ipc.listeners.get('gosai:windows-changed')?.([]);
    off();
    expect(seen).toEqual([[]]);
    expect(ipc.listeners.has('gosai:windows-changed')).toBe(false);
  });

  test('handlers reject arguments the contract does not allow', () => {
    const { handlers } = new RecordingTransport();
    const run = handlers['gosai:calibration:run'];
    expect(() => run({ appSlug: '../etc' })).toThrow('invalid appSlug');
    expect(() => run({ appSlug: 'pool', displayId: 1.5 })).toThrow('invalid displayId');
    expect(() => run(null)).toThrow('invalid appSlug');
  });
});
