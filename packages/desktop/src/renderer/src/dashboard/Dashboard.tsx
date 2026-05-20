import { useEffect, useState } from 'react';
import { ServerProvider, useServer } from '../lib/server-context.js';
import { AppsPanel } from './panels/AppsPanel.js';
import { DriversPanel } from './panels/DriversPanel.js';
import { ExperiencesPanel } from './panels/ExperiencesPanel.js';
import { LogsPanel } from './panels/LogsPanel.js';
import { SettingsPanel } from './panels/SettingsPanel.js';
import { SystemHeader } from './SystemHeader.js';

type TabId = 'apps' | 'drivers' | 'experiences' | 'logs' | 'settings';

interface Tab {
  id: TabId;
  label: string;
}

const TABS: readonly Tab[] = [
  { id: 'apps', label: 'Apps' },
  { id: 'experiences', label: 'Experiences' },
  { id: 'drivers', label: 'Drivers' },
  { id: 'logs', label: 'Logs' },
  { id: 'settings', label: 'Settings' },
];

export function Dashboard(): React.ReactElement {
  return (
    <ServerProvider>
      <DashboardShell />
    </ServerProvider>
  );
}

function DashboardShell(): React.ReactElement {
  const [active, setActive] = useState<TabId>('apps');

  return (
    <div className="flex h-full flex-col bg-neutral-950 text-neutral-100">
      <SystemHeader />

      <div className="flex flex-1 overflow-hidden">
        <nav className="flex w-44 shrink-0 flex-col border-r border-neutral-800 bg-neutral-900/40 py-2">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActive(tab.id)}
              className={`px-4 py-2 text-left text-sm transition-colors ${
                active === tab.id
                  ? 'bg-neutral-800 text-neutral-50'
                  : 'text-neutral-400 hover:bg-neutral-900 hover:text-neutral-100'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </nav>

        <main className="flex-1 overflow-auto">
          <PanelGate active={active} />
        </main>
      </div>

      <StatusBar />
    </div>
  );
}

function PanelGate({ active }: { active: TabId }): React.ReactElement {
  switch (active) {
    case 'apps':
      return <AppsPanel />;
    case 'drivers':
      return <DriversPanel />;
    case 'experiences':
      return <ExperiencesPanel />;
    case 'logs':
      return <LogsPanel />;
    case 'settings':
      return <SettingsPanel />;
  }
}

function StatusBar(): React.ReactElement {
  const { status } = useServer();
  const [systemStats, setSystemStats] = useState<{
    cpuPercent: number;
    memoryBytes: number;
    memoryTotalBytes: number;
    uptimeMs: number;
  } | null>(null);

  const { client } = useServer();
  useEffect(() => {
    const off = client.on('system:stats', (payload) => {
      setSystemStats(payload as typeof systemStats);
    });
    return off;
  }, [client]);

  return (
    <footer className="flex items-center justify-between border-t border-neutral-800 bg-neutral-900/60 px-4 py-1.5 font-mono text-[11px] text-neutral-400">
      <div className="flex items-center gap-3">
        <span className="flex items-center gap-1.5">
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              status === 'connected'
                ? 'bg-green-500'
                : status === 'connecting'
                  ? 'bg-yellow-500'
                  : 'bg-red-500'
            }`}
          />
          <span>{status}</span>
        </span>
        <span className="text-neutral-600">·</span>
        <span>{window.gosai?.platform ?? 'unknown'}</span>
      </div>
      <div className="flex items-center gap-3">
        {systemStats ? (
          <>
            <span>cpu {systemStats.cpuPercent.toFixed(1)}%</span>
            <span className="text-neutral-600">·</span>
            <span>
              mem {(systemStats.memoryBytes / 1024 / 1024 / 1024).toFixed(2)}/
              {(systemStats.memoryTotalBytes / 1024 / 1024 / 1024).toFixed(2)} GiB
            </span>
            <span className="text-neutral-600">·</span>
            <span>up {formatUptime(systemStats.uptimeMs)}</span>
          </>
        ) : (
          <span className="text-neutral-600">awaiting stats…</span>
        )}
      </div>
    </footer>
  );
}

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h${m}m`;
  if (m > 0) return `${m}m${s}s`;
  return `${s}s`;
}
