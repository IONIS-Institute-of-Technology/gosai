import type { AppLogger, LogLevel, ServerConnection } from './types.js';

/**
 * App-scoped logger. Routes every entry into the GOSAI server log stream so
 * it shows up in the dashboard logs panel alongside server-side logs.
 */
export class AppLoggerImpl implements AppLogger {
  constructor(
    private readonly source: string,
    private readonly server: ServerConnection,
  ) {}

  debug(message: string, data?: Record<string, unknown>): void {
    this.send('debug', message, data);
  }
  info(message: string, data?: Record<string, unknown>): void {
    this.send('info', message, data);
  }
  warn(message: string, data?: Record<string, unknown>): void {
    this.send('warn', message, data);
  }
  error(message: string, data?: Record<string, unknown>): void {
    this.send('error', message, data);
  }

  private send(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    // Best-effort: fire and forget. If the server isn't connected the message
    // is lost (matches the legacy behaviour). Console fallback so dev work
    // is still visible in the browser console.
    if (level === 'error') console.error(`[${this.source}] ${message}`, data);
    else if (level === 'warn') console.warn(`[${this.source}] ${message}`, data);
    else console.log(`[${this.source}] ${message}`, data);

    void this.server
      .request('app:log', {
        source: this.source,
        level,
        message,
        data: data ?? null,
      })
      .catch(() => {
        // Server may not implement app:log yet; treat as best-effort.
      });
  }
}
