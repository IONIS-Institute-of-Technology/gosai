import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatLogData, type LogEntry, type LogLevel } from '@gosai/shared';
import { useServer } from '../../lib/server-context.js';
import { Panel } from '../components/Panel.js';

const LEVEL_COLORS: Record<LogLevel, string> = {
  debug: 'text-neutral-500',
  info: 'text-neutral-200',
  warn: 'text-yellow-300',
  error: 'text-red-300',
};

export function LogsPanel(): React.ReactElement {
  const { client, status } = useServer();
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [filter, setFilter] = useState('');
  const [level, setLevel] = useState<'all' | LogLevel>('all');
  const [autoScroll, setAutoScroll] = useState(true);
  const tailRef = useRef<HTMLDivElement | null>(null);

  const append = useCallback((entry: LogEntry) => {
    setLogs((prev) => {
      const next = prev.concat(entry);
      if (next.length > 2000) next.splice(0, next.length - 2000);
      return next;
    });
  }, []);

  useEffect(() => {
    if (status !== 'connected') return;
    void (async () => {
      try {
        const history = (await client.request('logs:history')) as { logs: LogEntry[] };
        setLogs(history.logs);
      } catch {
        // ignore
      }
    })();
  }, [client, status]);

  useEffect(() => {
    const off = client.on('server:log', (payload) => append(payload as LogEntry));
    return off;
  }, [client, append]);

  useEffect(() => {
    if (autoScroll && tailRef.current) {
      tailRef.current.scrollIntoView({ behavior: 'instant', block: 'end' });
    }
  }, [logs, autoScroll]);

  const filtered = useMemo(() => {
    const text = filter.toLowerCase();
    return logs.filter((entry) => {
      if (level !== 'all' && entry.level !== level) return false;
      if (!text) return true;
      const dataText = entry.data ? formatLogData(entry.data).toLowerCase() : '';
      return (
        entry.source.toLowerCase().includes(text) ||
        entry.message.toLowerCase().includes(text) ||
        dataText.includes(text)
      );
    });
  }, [logs, level, filter]);

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <Panel title="Filters" compact>
        <div className="flex flex-wrap items-center gap-3">
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="search source or message"
            className="flex-1 min-w-[200px] rounded border border-neutral-800 bg-neutral-950 px-3 py-1.5 font-mono text-xs text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none"
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
          <button
            type="button"
            onClick={() => setLogs([])}
            className="rounded border border-neutral-700 px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-neutral-300 hover:bg-neutral-800"
          >
            clear
          </button>
        </div>
      </Panel>

      <div className="flex-1 overflow-auto rounded border border-neutral-800 bg-neutral-950/80 font-mono text-[11px] leading-5">
        <table className="w-full">
          <tbody>
            {filtered.map((entry, idx) => (
              <tr key={`${entry.timestamp}-${idx}`} className="border-b border-neutral-900/80">
                <td className="whitespace-nowrap px-2 py-0.5 align-top text-neutral-600">
                  {formatTime(entry.timestamp)}
                </td>
                <td className="whitespace-nowrap px-2 py-0.5 align-top">
                  <span className={`uppercase ${LEVEL_COLORS[entry.level]}`}>{entry.level}</span>
                </td>
                <td className="whitespace-nowrap px-2 py-0.5 align-top text-neutral-500">
                  {entry.source}
                </td>
                <td className="px-2 py-0.5 text-neutral-300">
                  <div className="whitespace-pre-wrap break-words">{entry.message}</div>
                  {entry.data && Object.keys(entry.data).length > 0 ? (
                    <pre className="mt-0.5 whitespace-pre-wrap break-words text-neutral-500">
                      {formatLogData(entry.data)}
                    </pre>
                  ) : null}
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

function formatTime(ts: number): string {
  const d = new Date(ts);
  return (
    d.toLocaleTimeString(undefined, { hour12: false }) +
    '.' +
    String(d.getMilliseconds()).padStart(3, '0')
  );
}
