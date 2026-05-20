import { appendFileSync, statSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { LogEntry, LogLevel } from '@gosai/shared';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LoggerOptions {
  readonly logsDir: string;
  readonly fileName?: string;
  readonly minLevel?: LogLevel;
  readonly maxBytes?: number;
  readonly maxBacklog?: number;
}

export type LogListener = (entry: LogEntry) => void;

const DEFAULT_FILE = 'gosai.log';
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_BACKLOG = 500;

export class Logger {
  private readonly logsDir: string;
  private readonly fileName: string;
  private readonly maxBytes: number;
  private readonly backlog: LogEntry[] = [];
  private readonly backlogLimit: number;
  private readonly listeners = new Set<LogListener>();
  private minLevel: LogLevel;
  private currentSize = 0;

  constructor(options: LoggerOptions) {
    this.logsDir = options.logsDir;
    this.fileName = options.fileName ?? DEFAULT_FILE;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.backlogLimit = options.maxBacklog ?? DEFAULT_BACKLOG;
    this.minLevel = options.minLevel ?? 'debug';

    mkdirSync(this.logsDir, { recursive: true });
    const path = this.filePath();
    if (existsSync(path)) {
      try {
        this.currentSize = statSync(path).size;
      } catch {
        this.currentSize = 0;
      }
    }
  }

  setMinLevel(level: LogLevel): void {
    this.minLevel = level;
  }

  history(): readonly LogEntry[] {
    return this.backlog.slice();
  }

  subscribe(listener: LogListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  log(source: string, level: LogLevel, message: string, data?: Record<string, unknown>): void {
    if (LEVELS[level] < LEVELS[this.minLevel]) return;
    const entry: LogEntry = {
      timestamp: Date.now(),
      level,
      source,
      message,
      ...(data !== undefined ? { data } : {}),
    };
    this.persist(entry);
    this.broadcast(entry);
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

  private broadcast(entry: LogEntry): void {
    this.backlog.push(entry);
    if (this.backlog.length > this.backlogLimit) this.backlog.shift();
    for (const listener of this.listeners) {
      try {
        listener(entry);
      } catch {
        // Listener errors must never propagate.
      }
    }
  }

  private persist(entry: LogEntry): void {
    const line = `${JSON.stringify(entry)}\n`;
    const path = this.filePath();
    try {
      appendFileSync(path, line, 'utf8');
      this.currentSize += Buffer.byteLength(line, 'utf8');
      if (this.currentSize > this.maxBytes) {
        const rotated = `${path}.${Date.now()}`;
        renameSync(path, rotated);
        this.currentSize = 0;
      }
    } catch {
      // Disk errors are non-fatal; we keep the in-memory backlog.
    }
  }

  private filePath(): string {
    return join(this.logsDir, this.fileName);
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
