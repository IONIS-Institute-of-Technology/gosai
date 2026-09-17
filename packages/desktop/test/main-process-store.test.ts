import { describe, expect, test } from 'bun:test';
import { pushedStore } from '../src/renderer/src/lib/main-process.js';

describe('pushedStore', () => {
  test('loads on the first subscriber, takes pushes, and stops listening after the last', async () => {
    let push: (value: number) => void = () => undefined;
    let listening = false;
    let resolveLoad: (value: number) => void = () => undefined;
    const store = pushedStore(
      () => new Promise<number>((resolve) => (resolveLoad = resolve)),
      (listener) => {
        push = listener;
        listening = true;
        return () => (listening = false);
      },
    );
    let renders = 0;
    const off = store.subscribe(() => renders++);
    expect(store.getSnapshot()).toBeUndefined();
    // A push that arrives before the load answers wins over it.
    push(2);
    resolveLoad(1);
    await Promise.resolve();
    expect(store.getSnapshot()).toBe(2);
    push(3);
    expect(store.getSnapshot()).toBe(3);
    expect(renders).toBe(2);
    off();
    expect(listening).toBe(false);
  });
});
