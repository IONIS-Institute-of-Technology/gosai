import { useEffect, useMemo, useRef, useState } from 'react';
import { formatLogEntry, type LogEntry, type LogLevel } from '@gosai/shared';
import { useServerResource } from '../../lib/use-server-resource.js';
import { Button } from '../components/Button.js';
import { ErrorText } from '../components/ErrorText.js';
import { Panel } from '../components/Panel.js';

const MAX_ENTRIES = 2000;

const LEVEL_COLORS: Record<LogLevel, string> = {
  debug: 'text-neutral-500',
  info: 'text-neutral-200',
  warn: 'text-yellow-300',
  error: 'text-red-300',
};

const NO_LOGS: readonly LogEntry[] = [];

export function LogsPanel({ active }: { active: boolean }): React.ReactElement {
  const logs = useServerResource(
    { command: 'logs:history', select: (r) => r.logs },
    { 'server:log': (entry, current) => [...(current ?? []), entry].slice(-MAX_ENTRIES) },
  );
  const [filter, setFilter] = useState('');
  const [level, setLevel] = useState<'all' | LogLevel>('all');
  const [autoScroll, setAutoScroll] = useState(true);
  const tailRef = useRef<HTMLDivElement | null>(null);
  const entries = logs.data ?? NO_LOGS;

  useEffect(() => {
    if (active && autoScroll) {
      tailRef.current?.scrollIntoView({ behavior: 'instant', block: 'end' });
    }
  }, [entries, autoScroll, active]);

  // A hidden panel keeps collecting lines but renders none of them.
  const filtered = useMemo(() => {
    if (!active) return NO_LOGS;
    const text = filter.toLowerCase();
    return entries.filter((entry) => {
      if (level !== 'all' && entry.level !== level) return false;
      if (!text) return true;
      const formatted = formatLogEntry(entry);
      return (
        entry.source.toLowerCase().includes(text) ||
        formatted.message.toLowerCase().includes(text) ||
        (formatted.details ?? '').toLowerCase().includes(text)
      );
    });
  }, [entries, level, filter, active]);

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <Panel title="Filters" compact>
        <div className="flex flex-wrap items-center gap-3">
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="search source or message"
            className="min-w-[200px] flex-1 rounded border border-neutral-800 bg-neutral-950 px-3 py-1.5 font-mono text-xs text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none"
            spellCheck={false}
          />
          <select
            value={level}
            onChange={(e) => setLevel(e.target.value as 'all' | LogLevel)}
            className="rounded border border-neutral-800 bg-neutral-950 px-3 py-1.5 font-mono text-xs text-neutral-100"
          >
            <option value="all">all</option>
            <option value="debug">debug</option>
            <option value="info">info</option>
            <option value="warn">warn</option>
            <option value="error">error</option>
          </select>
          <label className="flex items-center gap-2 font-mono text-xs text-neutral-400">
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
            />
            auto-scroll
          </label>
          <Button size="sm" onClick={() => logs.set([])}>
            clear
          </Button>
        </div>
        <ErrorText error={logs.error} />
      </Panel>

      <div className="flex-1 overflow-auto rounded border border-neutral-800 bg-neutral-950/80 font-mono text-[11px] leading-5">
        <table className="w-full">
          <tbody>
            {filtered.map((entry, idx) => (
              <tr key={`${entry.timestamp}-${idx}`} className="border-b border-neutral-900/80">
                <td className="px-2 py-0.5 align-top whitespace-nowrap text-neutral-600">
                  {formatTime(entry.timestamp)}
                </td>
                <td className="px-2 py-0.5 align-top whitespace-nowrap">
                  <span className={`uppercase ${LEVEL_COLORS[entry.level]}`}>{entry.level}</span>
                </td>
                <td className="px-2 py-0.5 align-top whitespace-nowrap text-neutral-500">
                  {entry.source}
                </td>
                <td className="px-2 py-0.5 text-neutral-300">
                  <LogMessage entry={entry} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div ref={tailRef} />
      </div>
    </div>
  );
}

function LogMessage({ entry }: { entry: LogEntry }): React.ReactElement {
  const { message, details } = formatLogEntry(entry);
  return (
    <>
      <div className="break-words whitespace-pre-wrap">{message}</div>
      {details ? (
        <pre className="mt-0.5 break-words whitespace-pre-wrap text-neutral-500">{details}</pre>
      ) : null}
    </>
  );
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return (
    d.toLocaleTimeString(undefined, { hour12: false }) +
    '.' +
    String(d.getMilliseconds()).padStart(3, '0')
  );
}
