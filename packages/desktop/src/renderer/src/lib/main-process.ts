/**
 * What Electron main knows, kept current through the preload API: the
 * displays and the windows main opened for experiences.
 */

import { useSyncExternalStore } from 'react';
import type { AppWindowInfo, DisplayList } from '../../../ipc-contract.js';

interface PushedStore<T> {
  subscribe(listener: () => void): () => void;
  getSnapshot(): T | undefined;
}

/** A value main loads on request and pushes on change. Loaded again on every first subscriber. */
export function pushedStore<T>(
  load: () => Promise<T>,
  onChanged: (listener: (value: T) => void) => () => void,
): PushedStore<T> {
  let value: T | undefined;
  let off: (() => void) | null = null;
  const listeners = new Set<() => void>();
  let version = 0;
  const set = (next: T): void => {
    version++;
    value = next;
    for (const listener of Array.from(listeners)) listener();
  };
  return {
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) {
        off = onChanged(set);
        const loadVersion = version;
        load().then(
          (loaded) => {
            // A push that arrived meanwhile is newer.
            if (version === loadVersion) set(loaded);
          },
          (err: unknown) => console.error('[gosai] could not load from the main process', err),
        );
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size > 0) return;
        off?.();
        off = null;
      };
    },
    getSnapshot: () => value,
  };
}

const displays = pushedStore<DisplayList>(
  () => window.gosai.displays.list(),
  (listener) => window.gosai.displays.onChanged(listener),
);

const windows = pushedStore<readonly AppWindowInfo[]>(
  () => window.gosai.windows.list(),
  (listener) => window.gosai.windows.onChanged(listener),
);

/** The displays, or `undefined` until main answered. */
export function useDisplays(): DisplayList | undefined {
  return useSyncExternalStore(displays.subscribe, displays.getSnapshot);
}

const NO_WINDOWS: readonly AppWindowInfo[] = [];

/** The windows main has open for experiences. */
export function useAppWindows(): readonly AppWindowInfo[] {
  return useSyncExternalStore(windows.subscribe, windows.getSnapshot) ?? NO_WINDOWS;
}
