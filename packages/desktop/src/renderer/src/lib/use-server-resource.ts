import { useMemo, useSyncExternalStore } from 'react';
import type { CommandName, CommandResponse } from '@gosai/shared/protocol';
import { useServer } from './server-context.js';
import {
  ServerResource,
  type ResourceEvents,
  type ResourceRequest,
  type ResourceSnapshot,
} from './server-resource.js';

export interface ServerResourceView<T> extends ResourceSnapshot<T> {
  reload(): Promise<T | undefined>;
  set(data: T): void;
}

/**
 * Loads a command's response on every connection and applies `events` to it.
 * A request with another command, payload, `enabled` or `key` starts a new resource;
 * `select` and the event handlers are read when it starts.
 */
export function useServerResource<C extends CommandName, T = CommandResponse<C>>(
  request: ResourceRequest<C, T>,
  events: ResourceEvents<NoInfer<T>> = {},
): ServerResourceView<T> {
  const { client } = useServer();
  const key = JSON.stringify([
    request.command,
    request.payload ?? null,
    request.enabled ?? true,
    request.key ?? null,
  ]);
  // The key stands for the request; the handlers are meant to be captured once.
  const resource = useMemo(
    () => new ServerResource(client, request, events),
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [client, key],
  );
  const snapshot = useSyncExternalStore(resource.subscribe, resource.getSnapshot);
  return { ...snapshot, reload: resource.reload, set: resource.set };
}
