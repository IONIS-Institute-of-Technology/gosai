import { useState } from 'react';
import { requestErrorMessage } from '../../lib/errors.js';
import { useAppWindows } from '../../lib/main-process.js';
import { useServer } from '../../lib/server-context.js';
import { useServerResource } from '../../lib/use-server-resource.js';
import { Button } from '../components/Button.js';
import { EmptyState } from '../components/EmptyState.js';
import { ErrorText } from '../components/ErrorText.js';
import { Panel } from '../components/Panel.js';

export function ExperiencesPanel(): React.ReactElement {
  const { client } = useServer();
  const running = useServerResource(
    { command: 'experiences:list', select: (r) => r.experiences },
    { 'experiences:list-changed': (p) => p.experiences },
  );
  const windows = useAppWindows();
  const [error, setError] = useState<string | null>(null);

  // Main closes the experience's windows once the server reports it stopped.
  const stop = async (appSlug: string, experienceSlug: string): Promise<void> => {
    setError(null);
    try {
      await client.request('experience:stop', { appSlug, experienceSlug });
    } catch (err) {
      setError(requestErrorMessage(err));
    }
  };

  const experiences = running.data ?? [];

  return (
    <div className="space-y-6 p-6">
      <Panel title={`Running Experiences (${experiences.length})`}>
        <ErrorText error={error ?? running.error} />
        {experiences.length === 0 ? (
          <EmptyState message="No experiences are running" />
        ) : (
          <ul className="space-y-2">
            {experiences.map((r) => (
              <li
                key={`${r.appSlug}/${r.experienceSlug}`}
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
                <Button
                  size="sm"
                  variant="stop"
                  disabled={r.state === 'stopping'}
                  onClick={() => void stop(r.appSlug, r.experienceSlug)}
                >
                  stop
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title={`App Windows (${windows.length})`}>
        {windows.length === 0 ? (
          <EmptyState message="No app windows open" />
        ) : (
          <ul className="space-y-2">
            {windows.map((w) => (
              <li
                key={w.windowId}
                className="rounded border border-neutral-800 bg-neutral-900/40 px-3 py-2 font-mono text-xs text-neutral-300"
              >
                window #{w.windowId} · {w.appSlug}/{w.experienceSlug} ·{' '}
                {w.role === 'control' ? 'control window' : `display ${w.displayId}`}
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
