/** Fold common structured log fields into the message for readability. */
export function enrichLogMessage(
  message: string,
  data?: Record<string, unknown>,
): { message: string; data?: Record<string, unknown> } {
  if (!data) return { message };
  const keys = Object.keys(data);
  if (keys.length === 0) return { message };

  if (keys.length === 1) {
    const key = keys[0]!;
    const val = data[key];
    if (
      val != null &&
      (key === 'line' ||
        key === 'err' ||
        key === 'error' ||
        key === 'stderr' ||
        key === 'stack' ||
        key === 'detail')
    ) {
      const text = typeof val === 'string' ? val : JSON.stringify(val);
      return { message: message ? `${message}: ${text}` : text };
    }
  }

  const suffix = keys.map((k) => `${k}=${formatLogValue(data[k])}`).join(' ');
  return { message: `${message} (${suffix})`, data };
}

/** Render optional log data for the dashboard (secondary to the message). */
export function formatLogData(data: Record<string, unknown>): string {
  const keys = Object.keys(data);
  if (keys.length === 1) {
    const key = keys[0]!;
    const val = data[key];
    if (key === 'line' || key === 'err' || key === 'error' || key === 'stderr') {
      return typeof val === 'string' ? val : JSON.stringify(val, null, 2);
    }
  }
  return JSON.stringify(data, null, 2);
}

function formatLogValue(value: unknown): string {
  if (typeof value === 'string') {
    return value.length > 500 ? `${value.slice(0, 500)}…` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  const json = JSON.stringify(value);
  return json.length > 500 ? `${json.slice(0, 500)}…` : json;
}
