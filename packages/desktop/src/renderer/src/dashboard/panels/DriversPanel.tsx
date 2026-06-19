import { useCallback, useEffect, useState } from 'react';
import type { DriverInfo, DriverRuntimeInfo } from '@gosai/shared';
import { useServer } from '../../lib/server-context.js';
import { isNotConnectedError } from '../../lib/server-client.js';
import { Panel } from '../components/Panel.js';
import { EmptyState } from '../components/EmptyState.js';

export function DriversPanel(): React.ReactElement {
  const { client, status } = useServer();
  const [drivers, setDrivers] = useState<DriverInfo[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const result = (await client.request('drivers:list')) as { drivers: DriverInfo[] };
      setDrivers(result.drivers);
    } catch (err) {
      if (!isNotConnectedError(err)) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
  }, [client]);

  useEffect(() => {
    if (status === 'connected') void refresh();
  }, [status, refresh]);

  useEffect(() => {
    const off = client.on('drivers:list-changed', (payload) => {
      const data = payload as { drivers: DriverInfo[] };
      setDrivers(data.drivers);
    });
    return off;
  }, [client]);

  return (
    <div className="space-y-6 p-6">
      <Panel title={`Drivers (${drivers.length})`}>
        {error ? <p className="font-mono text-xs text-red-400">{error}</p> : null}
        {drivers.length === 0 ? (
          <EmptyState message="No drivers registered" />
        ) : (
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-neutral-800 text-left font-mono text-[11px] uppercase tracking-wider text-neutral-500">
                <th className="py-2 pr-4">Name</th>
                <th className="py-2 pr-4">State</th>
                <th className="py-2 pr-4">Hardware</th>
                <th className="py-2 pr-4">Events</th>
                <th className="py-2 pr-4">Dependencies</th>
                <th className="py-2">Subscribers</th>
              </tr>
            </thead>
            <tbody className="font-mono text-xs">
              {drivers.map((d) => (
                <tr key={d.name} className="border-b border-neutral-900 hover:bg-neutral-900/30">
                  <td className="py-2 pr-4 text-neutral-100">{d.name}</td>
                  <td className="py-2 pr-4">
                    <StatePill state={d.state} />
                  </td>
                  <td className="py-2 pr-4 text-neutral-400">
                    <HardwareLabel runtime={d.runtime} />
                  </td>
                  <td className="py-2 pr-4 text-neutral-400">{d.events.join(', ') || '—'}</td>
                  <td className="py-2 pr-4 text-neutral-500">{d.dependencies.join(', ') || '—'}</td>
                  <td className="py-2 text-neutral-500">{d.subscribers.length}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}

function HardwareLabel({ runtime }: { runtime?: DriverRuntimeInfo }): React.ReactElement {
  if (!runtime) return <span className="text-neutral-600">—</span>;
  const device = runtime.device ?? (runtime.accelerated ? 'accelerated' : 'cpu');
  const provider = runtime.provider ? ` via ${runtime.provider}` : '';
  const model = runtime.model ? ` (${runtime.model})` : '';
  const title = [runtime.backend, runtime.reason].filter(Boolean).join(' · ');
  const cls = runtime.accelerated ? 'text-green-300' : 'text-yellow-300';
  return (
    <span className={cls} title={title || undefined}>
      {device}
      {provider}
      {model}
    </span>
  );
}

function StatePill({ state }: { state: string }): React.ReactElement {
  const colors: Record<string, string> = {
    available: 'bg-neutral-800 text-neutral-400',
    starting: 'bg-yellow-950 text-yellow-300',
    running: 'bg-green-950 text-green-300',
    paused: 'bg-blue-950 text-blue-300',
    stopping: 'bg-yellow-950 text-yellow-300',
    stopped: 'bg-neutral-800 text-neutral-400',
    errored: 'bg-red-950 text-red-300',
  };
  const cls = colors[state] ?? colors.available!;
  return (
    <span className={`rounded px-2 py-0.5 text-[10px] uppercase tracking-wider ${cls}`}>
      {state}
    </span>
  );
}
