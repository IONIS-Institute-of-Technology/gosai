/**
 * Server data the dashboard shows: loaded with a command, reloaded on every
 * connection, and kept current by server events. The store works with
 * `useSyncExternalStore` (see use-server-resource.ts) and has no React or DOM
 * dependency, so tests can drive it.
 */

import type {
  CommandName,
  CommandRequest,
  CommandResponse,
  FixedEventPayloads,
} from '@gosai/shared/protocol';
import type { FixedServerEventName } from '@gosai/shared/events';
import type { ServerClient } from '@gosai/shared/client';
import { requestErrorMessage } from './errors.js';

export type ResourceClient = Pick<ServerClient, 'request' | 'on' | 'onStatus'>;

export interface ResourceRequest<C extends CommandName, T> {
  readonly command: C;
  readonly payload?: CommandRequest<C>;
  /** Turns the response into the resource's value. Defaults to the response itself. */
  readonly select?: (response: CommandResponse<C>) => T;
  /** Nothing loads while false. */
  readonly enabled?: boolean;
  /** Not sent. A new value makes `useServerResource` start over, like a new payload. */
  readonly key?: string;
}

/** Returned by an event handler to load the resource again. */
export const RELOAD = Symbol('reload');

/**
 * How server events change a resource. Each handler returns the new value,
 * {@link RELOAD}, or `undefined` to ignore the event.
 */
export type ResourceEvents<T> = {
  readonly [E in FixedServerEventName]?: (
    payload: FixedEventPayloads[E],
    current: T | undefined,
  ) => T | typeof RELOAD | undefined;
};

export interface ResourceSnapshot<T> {
  /** The last value. Kept while reloading and while disconnected. */
  readonly data: T | undefined;
  /** Why the last load failed. Lost connections don't count. */
  readonly error: string | null;
  readonly loading: boolean;
}

export class ServerResource<C extends CommandName, T> {
  private snapshot: ResourceSnapshot<T> = { data: undefined, error: null, loading: false };
  private readonly listeners = new Set<() => void>();
  private offs: Array<() => void> = [];
  /** Bumped by every load and every event update; older loads are dropped. */
  private version = 0;

  constructor(
    private readonly client: ResourceClient,
    private readonly request: ResourceRequest<C, T>,
    private readonly events: ResourceEvents<T> = {},
  ) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.start();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stop();
    };
  };

  readonly getSnapshot = (): ResourceSnapshot<T> => this.snapshot;

  /** Loads the resource again. Resolves with the new value, or `undefined` when the load failed. */
  readonly reload = async (): Promise<T | undefined> => {
    if (this.request.enabled === false) return undefined;
    const version = ++this.version;
    this.update({ loading: true });
    try {
      const response = await (
        this.client.request as (command: C, payload?: CommandRequest<C>) => Promise<unknown>
      )(this.request.command, this.request.payload);
      const select = this.request.select ?? ((value: CommandResponse<C>) => value as T);
      const data = select(response as CommandResponse<C>);
      if (version === this.version) this.update({ data, error: null, loading: false });
      return data;
    } catch (err) {
      if (version === this.version) {
        this.update({ error: requestErrorMessage(err), loading: false });
      }
      return undefined;
    }
  };

  /** Replaces the value, for example with what a save returned. */
  readonly set = (data: T): void => {
    this.version++;
    this.update({ data, error: null, loading: false });
  };

  private start(): void {
    if (this.request.enabled === false) return;
    this.offs = [
      ...Object.entries(this.events).map(([name, apply]) =>
        this.client.on(name, (payload) => {
          const next = (apply as (payload: unknown, current: T | undefined) => unknown)(
            payload,
            this.snapshot.data,
          );
          if (next === RELOAD) void this.reload();
          else if (next !== undefined) this.set(next as T);
        }),
      ),
      this.client.onStatus((status) => {
        if (status === 'connected') void this.reload();
      }),
    ];
  }

  private stop(): void {
    for (const off of this.offs.splice(0)) off();
  }

  private update(patch: Partial<ResourceSnapshot<T>>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of Array.from(this.listeners)) listener();
  }
}
