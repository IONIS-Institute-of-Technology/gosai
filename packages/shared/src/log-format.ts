/**
 * Display formatting for log entries. The server stores entries as logged,
 * with structured data kept apart from the message; the dashboard formats them
 * with these helpers.
 */

import type { LogEntry } from './types.js';

/** Keys whose value reads as the continuation of the message, e.g. `failed: <err>`. */
const DETAIL_KEYS: ReadonlySet<string> = new Set([
  'line',
  'err',
  'error',
  'stderr',
  'stack',
  'detail',
]);

const MAX_VALUE_LENGTH = 500;

export interface FormattedLogEntry {
  /** The message, with a lone detail value appended. */
  readonly message: string;
  /** Remaining data as `key=value` pairs, or `null` when there is none. */
  readonly details: string | null;
}

export function formatLogEntry(entry: Pick<LogEntry, 'message' | 'data'>): FormattedLogEntry {
  const data = entry.data ?? {};
  const keys = Object.keys(data);
  if (keys.length === 0) return { message: entry.message, details: null };

  const [only] = keys;
  if (keys.length === 1 && only !== undefined && DETAIL_KEYS.has(only) && data[only] != null) {
    const detail = formatLogValue(data[only], Number.POSITIVE_INFINITY);
    return { message: entry.message ? `${entry.message}: ${detail}` : detail, details: null };
  }
  return {
    message: entry.message,
    details: keys.map((key) => `${key}=${formatLogValue(data[key], MAX_VALUE_LENGTH)}`).join(' '),
  };
}

function formatLogValue(value: unknown, maxLength: number): string {
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}
