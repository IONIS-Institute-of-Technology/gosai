import { useCallback, useEffect, useState } from 'react';
import type { RunningExperience } from '@gosai/shared';
import { useServer } from '../../lib/server-context.js';
import { stopExperienceFully } from '../../lib/stop-experience.js';
import { isNotConnectedError } from '../../lib/server-client.js';
import { Panel } from '../components/Panel.js';
import { EmptyState } from '../components/EmptyState.js';

interface AppHost {
  windowId: number;
  appSlug: string;
  experienceSlug: string;
  displayId: number;
}

export function ExperiencesPanel(): React.ReactElement {
  const { client, status } = useServer();
  const [running, setRunning] = useState<RunningExperience[]>([]);
  const [windows, setWindows] = useState<AppHost[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const result = (await client.request('experiences:list')) as {
        experiences: RunningExperience[];
      };
      setRunning(result.experiences);
    } catch (err) {
      if (!isNotConnectedError(err)) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
  }, [client]);

  const refreshWindows = useCallback(async () => {
    const api = window.gosai;
    if (!api) return;
    try {
      setWindows(await api.appHost.list());
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    if (status === 'connected') void refresh();
  }, [status, refresh]);

  useEffect(() => {
    void refreshWindows();
    const interval = setInterval(() => void refreshWindows(), 1500);
    return () => clearInterval(interval);
  }, [refreshWindows]);

  useEffect(() => {
    const off = client.on('experiences:list-changed', (payload) => {
      const data = payload as { experiences: RunningExperience[] };
      setRunning(data.experiences);
      void refreshWindows();
    });
    return off;
  }, [client, refreshWindows]);

  const stop = async (appSlug: string, experienceSlug: string): Promise<void> => {
    try {
      await stopExperienceFully(client, appSlug, experienceSlug);
      void refreshWindows();
    } catch (err) {
      if (!isNotConnectedError(err)) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
  };

  const closeWindow = async (windowId: number): Promise<void> => {
    try {
      await window.gosai?.appHost.close(windowId);
      void refreshWindows();
    } catch (err) {
      if (!isNotConnectedError(err)) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
  };

  return (
    <div className="space-y-6 p-6">
      <Panel title={`Running Experiences (${running.length})`}>
        {error ? <p className="font-mono text-xs text-red-400">{error}</p> : null}
        {running.length === 0 ? (
          <EmptyState message="No experiences are running" />
        ) : (
          <ul className="space-y-2">
            {running.map((r) => (
              <li
                key={`${r.appSlug}::${r.experienceSlug}`}
                className="flex items-center justify-between rounded border border-neutral-800 bg-neutral-900/40 px-3 py-2"
              >
                <div>
                  <div className="font-mono text-sm text-neutral-100">
                    {r.appSlug} <span className="text-neutral-500">/</span> {r.experienceSlug}
                  </div>
                  <div className="font-mono text-[11px] text-neutral-500">
                    state {r.state} · started {new Date(r.startedAt).toLocaleTimeString()}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void stop(r.appSlug, r.experienceSlug)}
                  className="rounded border border-red-900/50 bg-red-950/40 px-3 py-1 font-mono text-[10px] uppercase tracking-wider text-red-300 hover:bg-red-900/40"
                >
                  stop
                </button>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title={`App Windows (${windows.length})`}>
        {windows.length === 0 ? (
          <EmptyState message="No fullscreen app windows open" />
        ) : (
          <ul className="space-y-2">
            {windows.map((w) => (
              <li
                key={w.windowId}
                className="flex items-center justify-between rounded border border-neutral-800 bg-neutral-900/40 px-3 py-2"
              >
                <div className="font-mono text-xs text-neutral-300">
                  window #{w.windowId} · {w.appSlug}/{w.experienceSlug} · display {w.displayId}
                </div>
                <button
                  type="button"
                  onClick={() => void closeWindow(w.windowId)}
                  className="rounded border border-red-900/50 bg-red-950/40 px-3 py-1 font-mono text-[10px] uppercase tracking-wider text-red-300 hover:bg-red-900/40"
                >
                  kill
                </button>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
