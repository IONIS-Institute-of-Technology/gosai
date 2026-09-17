import { describe, expect, test } from 'bun:test';
import { LineSplitter } from '../src/drivers/bridge.js';

describe('LineSplitter', () => {
  test('joins lines split across chunks and emits several lines per chunk', () => {
    const lines: string[] = [];
    const splitter = new LineSplitter();
    for (const chunk of ['{"a"', ':1}\n{"b":2}\n{"c"', '', ':3}\n']) {
      splitter.push(chunk, (line) => lines.push(line));
    }
    expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });

  test('handles a long line delivered in many small chunks', () => {
    const payload = 'x'.repeat(200_000);
    const lines: string[] = [];
    const splitter = new LineSplitter();
    for (let i = 0; i < payload.length; i += 64) {
      splitter.push(payload.slice(i, i + 64), (line) => lines.push(line));
    }
    splitter.push('\n', (line) => lines.push(line));
    expect(lines).toEqual([payload]);
  });
});
