import { useCallback, useEffect, useState } from 'react';
import type { GlobalConfig } from '@gosai/shared';
import { useServer } from '../../lib/server-context.js';
import { isNotConnectedError } from '../../lib/server-client.js';
import { Panel } from '../components/Panel.js';
import { EmptyState } from '../components/EmptyState.js';

interface DisplaySummary {
  id: number;
  label: string;
  bounds: { x: number; y: number; width: number; height: number };
  scaleFactor: number;
  primary: boolean;
}

export function SettingsPanel(): React.ReactElement {
  const { client, status } = useServer();
  const [config, setConfig] = useState<GlobalConfig | null>(null);
  const [displays, setDisplays] = useState<DisplaySummary[]>([]);
  const [primaryId, setPrimaryId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const cfg = (await client.request('config:get')) as GlobalConfig;
      setConfig(cfg);
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
    const api = window.gosai;
    if (!api) return;
    void (async () => {
      const r = await api.displays.list();
      setDisplays(r.displays);
      setPrimaryId(r.primary.id);
    })();
  }, []);

  useEffect(() => {
    const off = client.on('server:config-changed', (payload) => setConfig(payload as GlobalConfig));
    return off;
  }, [client]);

  const updateConfig = async (patch: Partial<GlobalConfig>): Promise<void> => {
    setSaving(true);
    try {
      const next = (await client.request('config:set', patch)) as GlobalConfig;
      setConfig(next);
    } catch (err) {
      if (!isNotConnectedError(err)) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6 p-6">
      <Panel title="Display">
        {displays.length === 0 ? (
          <EmptyState message="No displays detected" />
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-neutral-400">
              Choose the display where fullscreen app windows will open.
            </p>
            <ul className="space-y-2">
              {displays.map((d) => {
                const selected = config?.displayId === d.id;
                return (
                  <li
                    key={d.id}
                    className={`flex items-center justify-between rounded border px-3 py-2 ${
                      selected
                        ? 'border-green-900/50 bg-green-950/30'
                        : 'border-neutral-800 bg-neutral-900/40'
                    }`}
                  >
                    <div>
                      <div className="text-sm text-neutral-100">{d.label}</div>
                      <div className="font-mono text-[11px] text-neutral-500">
                        {d.bounds.width}×{d.bounds.height} @ {d.scaleFactor}x
                        {d.id === primaryId ? ' · primary' : ''}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => void updateConfig({ displayId: d.id })}
                      disabled={saving}
                      className="rounded border border-neutral-700 px-3 py-1 font-mono text-[10px] uppercase tracking-wider text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
                    >
                      {selected ? 'selected' : 'use'}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </Panel>

      <Panel title="Configuration">
        {error ? <p className="font-mono text-xs text-red-400">{error}</p> : null}
        {config ? (
          <dl className="grid grid-cols-2 gap-x-8 gap-y-2 font-mono text-xs">
            <dt className="text-neutral-500 uppercase tracking-wider">Display ID</dt>
            <dd className="text-neutral-200">{config.displayId ?? '—'}</dd>

            <dt className="text-neutral-500 uppercase tracking-wider">Server Port</dt>
            <dd className="text-neutral-200">{config.serverPort}</dd>

            <dt className="text-neutral-500 uppercase tracking-wider">Auto-start Apps</dt>
            <dd className="text-neutral-200">
              {config.autoStartApps.length > 0 ? config.autoStartApps.join(', ') : '—'}
            </dd>
          </dl>
        ) : (
          <EmptyState message="Loading configuration…" />
        )}
      </Panel>
    </div>
  );
}
