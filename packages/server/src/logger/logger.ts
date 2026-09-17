/**
 * Server logger. Keeps a backlog for `logs:history`, notifies subscribers
 * (which publish `server:log`), and appends JSON lines to `gosai.log` in the
 * background. The file rotates at `maxBytes`, keeping `maxFiles` old files.
 *
 * Entries are stored as logged: structured data stays in `data` and the
 * dashboard decides how to show it.
 */

import { appendFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { LogEntry, LogLevel } from '@gosai/shared';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LoggerOptions {
  readonly logsDir: string;
  readonly fileName?: string;
  readonly minLevel?: LogLevel;
  readonly maxBytes?: number;
  /** Rotated files to keep besides the current one. */
  readonly maxFiles?: number;
  readonly maxBacklog?: number;
}

export type LogListener = (entry: LogEntry) => void;

const DEFAULT_FILE = 'gosai.log';
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_FILES = 5;
const DEFAULT_BACKLOG = 500;

export function levelAtLeast(level: LogLevel, minimum: LogLevel): boolean {
  return LEVELS[level] >= LEVELS[minimum];
}

export class Logger {
  private readonly path: string;
  private readonly fileName: string;
  private readonly maxBytes: number;
  private readonly maxFiles: number;
  private readonly minLevel: LogLevel;
  private readonly backlog: LogEntry[] = [];
  private readonly backlogLimit: number;
  private readonly listeners = new Set<LogListener>();
  private queued: string[] = [];
  private writing: Promise<void> | null = null;
  /** `null` until the first write reads the existing file size. */
  private size: number | null = null;
  private diskErrorReported = false;
  /** Suffix of the last rotated file; kept increasing so names never collide. */
  private lastRotation = 0;

  constructor(private readonly options: LoggerOptions) {
    this.fileName = options.fileName ?? DEFAULT_FILE;
    this.path = join(options.logsDir, this.fileName);
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
    this.backlogLimit = options.maxBacklog ?? DEFAULT_BACKLOG;
    this.minLevel = options.minLevel ?? 'debug';
    mkdirSync(options.logsDir, { recursive: true });
  }

  history(): readonly LogEntry[] {
    return this.backlog.slice();
  }

  subscribe(listener: LogListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  log(source: string, level: LogLevel, message: string, data?: Record<string, unknown>): void {
    if (!levelAtLeast(level, this.minLevel)) return;
    const entry: LogEntry = {
      timestamp: Date.now(),
      level,
      source,
      message,
      ...(data !== undefined && Object.keys(data).length > 0 ? { data } : {}),
    };
    this.queue(entry);
    this.backlog.push(entry);
    if (this.backlog.length > this.backlogLimit) this.backlog.shift();
    for (const listener of this.listeners) {
      try {
        listener(entry);
      } catch (err) {
        console.error('[gosai] log listener failed', err);
      }
    }
  }

  debug(source: string, message: string, data?: Record<string, unknown>): void {
    this.log(source, 'debug', message, data);
  }
  info(source: string, message: string, data?: Record<string, unknown>): void {
    this.log(source, 'info', message, data);
  }
  warn(source: string, message: string, data?: Record<string, unknown>): void {
    this.log(source, 'warn', message, data);
  }
  error(source: string, message: string, data?: Record<string, unknown>): void {
    this.log(source, 'error', message, data);
  }

  child(source: string): ChildLogger {
    return new ChildLogger(this, source);
  }

  /** Resolves once every entry logged so far is on disk. */
  async flush(): Promise<void> {
    while (this.writing) await this.writing;
  }

  private queue(entry: LogEntry): void {
    let line: string;
    try {
      line = `${JSON.stringify(entry)}\n`;
    } catch {
      line = `${JSON.stringify({ ...entry, data: { unserializable: true } })}\n`;
    }
    this.queued.push(line);
    this.writing ??= this.drain();
  }

  private async drain(): Promise<void> {
    // Let the entries logged in the same tick join the batch.
    await Promise.resolve();
    try {
      while (this.queued.length > 0) {
        const batch = this.queued.join('');
        this.queued = [];
        await this.write(batch);
      }
    } finally {
      this.writing = null;
    }
  }

  private async write(batch: string): Promise<void> {
    try {
      this.size ??= await stat(this.path).then(
        (s) => s.size,
        () => 0,
      );
      await appendFile(this.path, batch, 'utf8');
      this.size += Buffer.byteLength(batch, 'utf8');
      if (this.size > this.maxBytes) await this.rotate();
    } catch (err) {
      // The backlog still has the entries; say so once instead of per line.
      if (!this.diskErrorReported) {
        this.diskErrorReported = true;
        console.error(`[gosai] could not write ${this.path}`, err);
      }
    }
  }

  private async rotate(): Promise<void> {
    this.lastRotation = Math.max(Date.now(), this.lastRotation + 1);
    await rename(this.path, `${this.path}.${this.lastRotation}`);
    this.size = 0;
    const prefix = `${this.fileName}.`;
    const rotated = (await readdir(this.options.logsDir))
      .filter((name) => name.startsWith(prefix) && /^\d+$/.test(name.slice(prefix.length)))
      .sort((a, b) => Number(b.slice(prefix.length)) - Number(a.slice(prefix.length)));
    for (const name of rotated.slice(this.maxFiles)) {
      await rm(join(this.options.logsDir, name), { force: true });
    }
  }
}

export class ChildLogger {
  constructor(
    private readonly parent: Logger,
    private readonly source: string,
  ) {}

  debug(message: string, data?: Record<string, unknown>): void {
    this.parent.debug(this.source, message, data);
  }
  info(message: string, data?: Record<string, unknown>): void {
    this.parent.info(this.source, message, data);
  }
  warn(message: string, data?: Record<string, unknown>): void {
    this.parent.warn(this.source, message, data);
  }
  error(message: string, data?: Record<string, unknown>): void {
    this.parent.error(this.source, message, data);
  }
}
