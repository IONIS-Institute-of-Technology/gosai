import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger } from '../src/logger/logger.js';

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) {
    try {
      rmSync(dirs.pop()!, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

function newDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'gosai-logger-'));
  dirs.push(d);
  return d;
}

describe('Logger', () => {
  test('persists to backlog and notifies subscribers', () => {
    const logger = new Logger({ logsDir: newDir() });
    const got: string[] = [];
    logger.subscribe((e) => got.push(e.message));
    logger.info('test', 'first');
    logger.warn('test', 'second');
    expect(got).toEqual(['first', 'second']);
    expect(logger.history().map((e) => e.message)).toEqual(['first', 'second']);
  });

  test('respects minLevel', () => {
    const logger = new Logger({ logsDir: newDir(), minLevel: 'warn' });
    const got: string[] = [];
    logger.subscribe((e) => got.push(e.message));
    logger.debug('test', 'ignored');
    logger.info('test', 'ignored');
    logger.warn('test', 'kept');
    logger.error('test', 'kept');
    expect(got).toEqual(['kept', 'kept']);
  });

  test('child logger forwards source', () => {
    const logger = new Logger({ logsDir: newDir() });
    const got: Array<{ source: string; message: string }> = [];
    logger.subscribe((e) => got.push({ source: e.source, message: e.message }));
    logger.child('drivers').info('a thing happened');
    expect(got[0]).toEqual({ source: 'drivers', message: 'a thing happened' });
  });
});
