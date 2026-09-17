import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
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

  test('keeps structured data apart from the message', () => {
    const logger = new Logger({ logsDir: newDir() });
    logger.warn('bridge', 'driver failed', { err: 'boom', driver: 'pose' });
    logger.info('bridge', 'no data', {});
    expect(logger.history()[0]).toMatchObject({
      message: 'driver failed',
      data: { err: 'boom', driver: 'pose' },
    });
    expect(logger.history()[1]).not.toHaveProperty('data');
  });

  test('writes entries in the background, in order', async () => {
    const dir = newDir();
    const logger = new Logger({ logsDir: dir });
    for (let i = 0; i < 50; i++) logger.info('test', `line ${i}`);
    await logger.flush();
    const lines = readFileSync(join(dir, 'gosai.log'), 'utf8').trim().split('\n');
    expect(lines.map((line) => (JSON.parse(line) as { message: string }).message)).toEqual(
      Array.from({ length: 50 }, (_, i) => `line ${i}`),
    );
  });

  test('rotates the file and deletes the oldest rotated files', async () => {
    const dir = newDir();
    const logger = new Logger({ logsDir: dir, maxBytes: 200, maxFiles: 2 });
    for (let round = 0; round < 6; round++) {
      logger.info('test', 'x'.repeat(250));
      await logger.flush();
    }
    const rotated = readdirSync(dir).filter((name) => name.startsWith('gosai.log.'));
    expect(rotated).toHaveLength(2);
  });
});
