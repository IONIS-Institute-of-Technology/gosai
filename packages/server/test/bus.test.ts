import { describe, expect, test } from 'bun:test';
import { EventBus, type EventMeta } from '../src/ipc/bus.js';

describe('EventBus', () => {
  test('delivers events to exact matches', () => {
    const bus = new EventBus();
    const received: string[] = [];
    bus.on('hello', (_e, p) => received.push(String(p)));
    bus.emit('hello', 'world');
    expect(received).toEqual(['world']);
  });

  test('delivers events to namespace wildcards', () => {
    const bus = new EventBus();
    const received: string[] = [];
    bus.on('driver:*', (e) => received.push(e));
    bus.emit('driver:first', { foo: 1 });
    bus.emit('driver:custom', { foo: 2 });
    bus.emit('apps:custom', { foo: 3 });
    expect(received).toEqual(['driver:first', 'driver:custom']);
  });

  test('delivers to * subscribers', () => {
    const bus = new EventBus();
    let count = 0;
    bus.on('*', () => count++);
    bus.emit('a', 1);
    bus.emit('b:c', 2);
    expect(count).toBe(2);
  });

  test('unsubscribes correctly', () => {
    const bus = new EventBus();
    let count = 0;
    const off = bus.on('x', () => count++);
    bus.emit('x', 1);
    off();
    bus.emit('x', 2);
    expect(count).toBe(1);
  });

  test('listener exceptions never propagate and are reported', () => {
    const errors: string[] = [];
    const bus = new EventBus({
      onListenerError: (err, event) => errors.push(`${event}: ${String(err)}`),
    });
    bus.on('boom', () => {
      throw new Error('explode');
    });
    let other = 0;
    bus.on('boom', () => other++);
    bus.emit('boom', null);
    expect(other).toBe(1);
    expect(errors).toEqual(['boom: Error: explode']);
  });

  test('passes the source and origin along', () => {
    const bus = new EventBus();
    const metas: EventMeta[] = [];
    bus.on('*', (_event, _payload, meta) => metas.push(meta));
    bus.emit('app:pool:topic', 1, 'app:pool', 'client-1');
    expect(metas[0]?.source).toBe('app:pool');
    expect(metas[0]?.origin).toBe('client-1');
  });
});
