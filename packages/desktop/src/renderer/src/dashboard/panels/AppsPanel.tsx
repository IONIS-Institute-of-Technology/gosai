import { useCallback, useEffect, useRef, useState } from 'react';
import type { InstalledApp, RunningExperience } from '@gosai/shared';
import { useServer } from '../../lib/server-context.js';
import { isNotConnectedError } from '../../lib/server-client.js';
import { Panel } from '../components/Panel.js';
import { EmptyState } from '../components/EmptyState.jsx';

const CALIBRATION_SLUG = 'calibration';

export function AppsPanel(): React.ReactElement {
  const { client, status } = useServer();
  const [apps, setApps] = useState<InstalledApp[]>([]);
  const [running, setRunning] = useState<RunningExperience[]>([]);
  const [installSource, setInstallSource] = useState('');
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const appsResult = (await client.request('apps:list')) as { apps: InstalledApp[] };
      setApps(appsResult.apps);
    } catch (err) {
      if (!isNotConnectedError(err)) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
    try {
      const expResult = (await client.request('experiences:list')) as {
        experiences: RunningExperience[];
      };
      setRunning(expResult.experiences);
    } catch {
      // ignore
    }
  }, [client]);

  useEffect(() => {
    if (status === 'connected') void refresh();
  }, [status, refresh]);

  useEffect(() => {
    const offList = client.on('apps:list-changed', (payload) => {
      const data = payload as { apps: InstalledApp[] };
      setApps(data.apps);
    });
    const offRunning = client.on('experiences:list-changed', (payload) => {
      const data = payload as { experiences: RunningExperience[] };
      setRunning(data.experiences);
    });
    return () => {
      offList();
      offRunning();
    };
  }, [client]);

  const handleInstall = async (): Promise<void> => {
    if (!installSource.trim()) return;
    setInstalling(true);
    setError(null);
    try {
      await client.request('app:install', { source: installSource.trim() });
      setInstallSource('');
    } catch (err) {
      if (!isNotConnectedError(err)) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setInstalling(false);
    }
  };

  const handleUninstall = async (slug: string): Promise<void> => {
    if (!confirm(`Uninstall ${slug}?`)) return;
    try {
      await client.request('app:uninstall', { slug });
    } catch (err) {
      if (!isNotConnectedError(err)) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
  };

  return (
    <div className="space-y-6 p-6">
      <Panel title="Install an app">
        <div className="space-y-3">
          <p className="text-xs text-neutral-400">
            Paste a git repository URL containing a <code className="font-mono">gosai.app.json</code>.
          </p>
          <div className="flex gap-2">
            <input
              type="text"
              value={installSource}
              onChange={(e) => setInstallSource(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void handleInstall()}
              placeholder="https://github.com/owner/repo.git"
              className="flex-1 rounded border border-neutral-800 bg-neutral-950 px-3 py-2 font-mono text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none"
              spellCheck={false}
            />
            <button
              type="button"
              onClick={() => void handleInstall()}
              disabled={installing || !installSource.trim()}
              className="rounded border border-neutral-700 bg-neutral-800 px-4 py-2 text-sm text-neutral-100 hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {installing ? 'Installing…' : 'Install'}
            </button>
          </div>
          {error ? <p className="font-mono text-xs text-red-400">{error}</p> : null}
        </div>
      </Panel>

      <Panel title={`Installed (${apps.length})`}>
        {apps.length === 0 ? (
          <EmptyState message="No apps installed yet" />
        ) : (
          <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {apps.map((app) => (
              <AppCard
                key={app.manifest.slug}
                app={app}
                running={running.filter((r) => r.appSlug === app.manifest.slug)}
                onUninstall={handleUninstall}
                onError={setError}
              />
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

interface AppCardProps {
  app: InstalledApp;
  running: RunningExperience[];
  onUninstall(slug: string): Promise<void>;
  onError(msg: string): void;
}

function AppCard({ app, running, onUninstall, onError }: AppCardProps): React.ReactElement {
  const { client } = useServer();
  const [menuOpen, setMenuOpen] = useState(false);
  const isCalibration = app.manifest.slug === CALIBRATION_SLUG;
  const experiences = app.manifest.experiences;
  const defaultExp =
    experiences.find((e) => e.slug === app.manifest.default) ?? experiences[0] ?? null;

  const anyRunning = running.length > 0;

  // Close dropdown on outside click.
  const cardRef = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent): void => {
      if (cardRef.current && !cardRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  const startExperience = async (experienceSlug: string): Promise<void> => {
    try {
      await client.request('experience:start', { appSlug: app.manifest.slug, experienceSlug });
      const display = await pickDisplay(client);
      if (display) {
        await window.gosai?.appHost.open({
          displayId: display.id,
          appSlug: app.manifest.slug,
          experienceSlug,
          fullscreen: true,
        });
      }
    } catch (err) {
      if (!isNotConnectedError(err)) {
        onError(err instanceof Error ? err.message : String(err));
      }
    }
  };

  const stopExperience = async (experienceSlug: string): Promise<void> => {
    try {
      await client.request('experience:stop', { appSlug: app.manifest.slug, experienceSlug });
    } catch (err) {
      if (!isNotConnectedError(err)) {
        onError(err instanceof Error ? err.message : String(err));
      }
    }
  };

  const startCalibration = async (): Promise<void> => {
    try {
      await runCalibrationWizard(client, app.manifest.slug);
    } catch (err) {
      if (!isNotConnectedError(err)) {
        onError(err instanceof Error ? err.message : String(err));
      }
    }
  };

  const primaryRunning = defaultExp ? running.some((r) => r.experienceSlug === defaultExp.slug) : false;

  return (
    <li
      ref={cardRef}
      className="relative rounded border border-neutral-800 bg-neutral-900/50 p-4"
    >
      <header className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-medium text-neutral-100">{app.manifest.name}</h3>
            {app.manifest.builtin ? (
              <span className="rounded bg-neutral-800 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-neutral-400">
                built-in
              </span>
            ) : null}
          </div>
          <p className="font-mono text-xs text-neutral-500">
            {app.manifest.slug} v{app.manifest.version}
          </p>
        </div>
        {!app.manifest.builtin ? (
          <button
            type="button"
            onClick={() => void onUninstall(app.manifest.slug)}
            className="font-mono text-[10px] uppercase tracking-wider text-neutral-600 hover:text-red-400"
          >
            uninstall
          </button>
        ) : null}
      </header>

      {app.manifest.description ? (
        <p className="mt-2 text-xs text-neutral-400">{app.manifest.description}</p>
      ) : null}

      <div className="mt-4 flex items-stretch gap-2">
        {isCalibration ? (
          <button
            type="button"
            onClick={() => void startCalibration()}
            className="flex-1 rounded border border-amber-900/50 bg-amber-950/40 px-4 py-2 text-sm font-medium text-amber-200 transition-colors hover:bg-amber-900/40"
          >
            Calibrate
          </button>
        ) : defaultExp ? (
          <button
            type="button"
            onClick={() =>
              primaryRunning
                ? void stopExperience(defaultExp.slug)
                : void startExperience(defaultExp.slug)
            }
            className={`flex-1 rounded border px-4 py-2 text-sm font-medium transition-colors ${
              primaryRunning
                ? 'border-red-900/50 bg-red-950/40 text-red-200 hover:bg-red-900/40'
                : 'border-green-900/50 bg-green-950/40 text-green-200 hover:bg-green-900/40'
            }`}
            title={defaultExp.name}
          >
            {primaryRunning ? `Stop ${defaultExp.name}` : `Start ${defaultExp.name}`}
          </button>
        ) : (
          <span className="flex-1 rounded border border-neutral-800 bg-neutral-950/50 px-4 py-2 text-center text-xs text-neutral-500">
            no experiences defined
          </span>
        )}

        {experiences.length > 1 || (isCalibration && experiences.length >= 1) ? (
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            aria-label="More experiences"
            className="rounded border border-neutral-700 bg-neutral-800 px-3 text-sm text-neutral-100 hover:bg-neutral-700"
          >
            ▾
          </button>
        ) : null}
      </div>

      {menuOpen ? (
        <div className="absolute right-4 top-[100%] z-20 mt-1 min-w-[240px] rounded border border-neutral-700 bg-neutral-900 p-1 shadow-xl">
          <p className="px-3 pb-1 pt-2 font-mono text-[10px] uppercase tracking-wider text-neutral-500">
            experiences
          </p>
          {experiences.map((exp) => {
            const isRunning = running.some((r) => r.experienceSlug === exp.slug);
            const isDefault = exp.slug === (app.manifest.default ?? experiences[0]?.slug);
            return (
              <button
                key={exp.slug}
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  if (isRunning) void stopExperience(exp.slug);
                  else void startExperience(exp.slug);
                }}
                className="flex w-full items-center justify-between gap-3 rounded px-3 py-2 text-left text-xs text-neutral-200 hover:bg-neutral-800"
              >
                <span className="flex flex-col">
                  <span className="font-mono text-neutral-100">{exp.slug}</span>
                  <span className="text-[11px] text-neutral-500">{exp.name}</span>
                </span>
                <span className="flex items-center gap-2">
                  {isDefault ? (
                    <span className="font-mono text-[10px] uppercase tracking-wider text-neutral-500">
                      default
                    </span>
                  ) : null}
                  <span
                    className={`font-mono text-[10px] uppercase tracking-wider ${
                      isRunning ? 'text-red-400' : 'text-green-400'
                    }`}
                  >
                    {isRunning ? 'stop' : 'start'}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      ) : null}

      {anyRunning && !isCalibration ? (
        <p className="mt-3 font-mono text-[10px] uppercase tracking-wider text-neutral-500">
          running: {running.map((r) => r.experienceSlug).join(', ')}
        </p>
      ) : null}
    </li>
  );
}

async function pickDisplay(
  client: WizardClient,
): Promise<{ id: number; label: string } | null> {
  const api = window.gosai;
  if (!api) return null;
  const { displays, primary } = await api.displays.list();
  if (displays.length <= 1) return primary;

  try {
    const config = (await client.request('config:get')) as { displayId?: number | null };
    if (config.displayId != null) {
      const match = displays.find((d) => d.id === config.displayId);
      if (match) return match;
    }
  } catch {
    // Fall through to primary if config fetch fails.
  }
  return primary;
}

interface WizardClient {
  request<T = unknown>(type: string, payload?: unknown): Promise<T>;
  on(event: string, listener: (payload: unknown) => void): () => void;
}

async function runCalibrationWizard(
  client: WizardClient,
  appSlug: string,
): Promise<void> {
  const api = window.gosai;
  if (!api) throw new Error('Electron API unavailable');

  const experienceSlug = 'calibrate';
  await client.request('experience:start', { appSlug, experienceSlug });

  const display = await pickDisplay(client);
  if (!display) throw new Error('No display available for calibration');

  // Open control before the projector so macOS does not tear down the
  // fullscreen window when the always-on-top control window is created.
  const control = await api.controlWindow.open({
    appSlug,
    experienceSlug,
    projectorDisplayId: display.id,
    title: 'Calibration · Control',
    width: 960,
    height: 720,
  });

  const projector = await api.appHost.open({
    displayId: display.id,
    appSlug,
    experienceSlug,
    fullscreen: true,
  });

  let finished = false;
  const finish = async (): Promise<void> => {
    if (finished) return;
    finished = true;
    offStep();
    offWizardFinished();
    offExperienceEnded();
    try {
      await api.controlWindow.close(control.windowId);
    } catch {
      // ignore
    }
    try {
      await api.appHost.close(projector.windowId);
    } catch {
      // ignore
    }
    try {
      await client.request('experience:stop', { appSlug, experienceSlug });
    } catch {
      // ignore
    }
  };

  const offStep = (await listenForApp(client, `app:${appSlug}:wizard:step`, async (payload) => {
    const data = payload as { step?: string };
    if (!data?.step) return;
    if (data.step === 'background') {
      try {
        await api.controlWindow.hide(control.windowId);
      } catch {
        // ignore
      }
    } else {
      try {
        await api.controlWindow.show(control.windowId);
      } catch {
        // ignore
      }
    }
  })) as () => void;

  const offWizardFinished = (await listenForApp(
    client,
    `app:${appSlug}:wizard:finished`,
    () => finish(),
  )) as () => void;

  const offExperienceEnded = api.onExperienceEnded((payload) => {
    if (payload.appSlug === appSlug && payload.experienceSlug === experienceSlug) {
      void finish();
    }
  });
}

/**
 * Wraps `client.on(event, listener)` so the caller can `await` the
 * subscription returning the unsubscribe handle. The dashboard's
 * ServerClient `.on` returns the unsubscribe function synchronously, so
 * we just normalise here.
 */
async function listenForApp(
  client: WizardClient,
  event: string,
  listener: (payload: unknown) => void | Promise<void>,
): Promise<() => void> {
  return client.on(event, (payload) => {
    void listener(payload);
  });
}
