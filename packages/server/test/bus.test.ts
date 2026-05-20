import { describe, expect, test } from 'bun:test';
import { EventBus } from '../src/ipc/bus.js';

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
    bus.emit('driver:event', { foo: 1 });
    bus.emit('driver:state-changed', { foo: 2 });
    bus.emit('apps:list-changed', { foo: 3 });
    expect(received).toEqual(['driver:event', 'driver:state-changed']);
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

  test('listener exceptions never propagate', () => {
    const bus = new EventBus();
    bus.on('boom', () => {
      throw new Error('explode');
    });
    let other = 0;
    bus.on('boom', () => other++);
    bus.emit('boom', null);
    expect(other).toBe(1);
  });
});
