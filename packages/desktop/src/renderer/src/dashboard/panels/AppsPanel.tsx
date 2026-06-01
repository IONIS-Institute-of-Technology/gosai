import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AppDeviceSettings,
  AppDeviceSettingsPatch,
  DeviceCatalog,
  DisplayMode,
  InstalledApp,
  RunningExperience,
} from '@gosai/shared';
import {
  CALIBRATION_SLUG,
  pickDisplayForApp,
  runCalibrationWizard,
} from '../../lib/calibration-wizard.js';
import { stopAllAppExperiences, stopExperienceFully } from '../../lib/stop-experience.js';
import { useServer } from '../../lib/server-context.js';
import { isNotConnectedError } from '../../lib/server-client.js';
import { Panel } from '../components/Panel.js';
import { EmptyState } from '../components/EmptyState.jsx';

const SERVER_BASE_URL = 'http://127.0.0.1:7777';

interface DisplayChoice {
  id: number;
  label: string;
  primary: boolean;
}

type CalStatus = 'unknown' | 'calibrated' | 'required';

export function AppsPanel(): React.ReactElement {
  const { client, status } = useServer();
  const [apps, setApps] = useState<InstalledApp[]>([]);
  const [running, setRunning] = useState<RunningExperience[]>([]);
  const [installSource, setInstallSource] = useState('');
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Device catalog + displays are shared across rows and loaded lazily the
  // first time a row's accordion is opened, so we probe hardware at most once.
  const [devices, setDevices] = useState<DeviceCatalog | null>(null);
  const [displays, setDisplays] = useState<DisplayChoice[] | null>(null);
  const [devicesLoading, setDevicesLoading] = useState(false);
  const devicesLoadedRef = useRef(false);

  // Probe hardware at most once (shared across rows); `force` re-scans on demand.
  const loadDevices = useCallback(
    async (force = false): Promise<void> => {
      if (devicesLoadedRef.current && !force) return;
      devicesLoadedRef.current = true;
      setDevicesLoading(true);
      try {
        const [cat, disp] = await Promise.all([
          (client.request('devices:list') as Promise<DeviceCatalog>).catch(() => null),
          (window.gosai?.displays.list() ?? Promise.resolve(null)).catch(() => null),
        ]);
        if (cat) setDevices(cat);
        if (disp) {
          setDisplays(disp.displays.map((d) => ({ id: d.id, label: d.label, primary: d.primary })));
        }
      } finally {
        setDevicesLoading(false);
      }
    },
    [client],
  );

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

  const userApps = apps.filter((app) => app.manifest.slug !== CALIBRATION_SLUG);

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

      <Panel title={`Installed (${userApps.length})`}>
        {userApps.length === 0 ? (
          <EmptyState message="No apps installed yet" />
        ) : (
          <ul className="divide-y divide-neutral-800 overflow-hidden rounded border border-neutral-800">
            {userApps.map((app) => (
              <AppRow
                key={app.manifest.slug}
                app={app}
                running={running.filter((r) => r.appSlug === app.manifest.slug)}
                devices={devices}
                displays={displays}
                devicesLoading={devicesLoading}
                onNeedDevices={() => void loadDevices()}
                onRescanDevices={() => void loadDevices(true)}
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

interface AppRowProps {
  app: InstalledApp;
  running: RunningExperience[];
  devices: DeviceCatalog | null;
  displays: DisplayChoice[] | null;
  devicesLoading: boolean;
  onNeedDevices(): void;
  onRescanDevices(): void;
  onUninstall(slug: string): Promise<void>;
  onError(msg: string): void;
}

function AppRow({
  app,
  running,
  devices,
  displays,
  devicesLoading,
  onNeedDevices,
  onRescanDevices,
  onUninstall,
  onError,
}: AppRowProps): React.ReactElement {
  const { client } = useServer();
  const [expanded, setExpanded] = useState(false);
  const requirements = app.manifest.requirements ?? {};
  const hasRequirements =
    !!requirements.display ||
    !!requirements.camera ||
    !!requirements.microphone ||
    !!requirements.speaker;
  // Calibration maps a camera onto a display, so it only applies to apps needing both.
  const needsCalibration = !!requirements.display && !!requirements.camera;
  const experiences = app.manifest.experiences;
  const defaultExp =
    experiences.find((e) => e.slug === app.manifest.default) ?? experiences[0] ?? null;
  const anyRunning = running.length > 0;

  const [calStatus, setCalStatus] = useState<CalStatus>('unknown');
  const [calibrating, setCalibrating] = useState(false);

  const probeCalibration = useCallback(async (): Promise<void> => {
    if (!needsCalibration) return;
    const check = async (key: string): Promise<boolean> => {
      try {
        const res = await fetch(
          `${SERVER_BASE_URL}/v1/apps/${CALIBRATION_SLUG}/storage/${encodeURIComponent(key)}`,
        );
        return res.status === 200;
      } catch {
        return false;
      }
    };
    const ok = (await check(`homography__${app.manifest.slug}`)) || (await check('homography'));
    setCalStatus(ok ? 'calibrated' : 'required');
  }, [app.manifest.slug, needsCalibration]);

  useEffect(() => {
    if (needsCalibration) void probeCalibration();
  }, [needsCalibration, probeCalibration]);

  useEffect(() => {
    if (!needsCalibration) return;
    return client.on(`app:${CALIBRATION_SLUG}:wizard:finished`, () => {
      void probeCalibration();
    });
  }, [client, needsCalibration, probeCalibration]);

  // Lazily load the shared device catalog the first time this row opens.
  useEffect(() => {
    if (expanded && hasRequirements) onNeedDevices();
  }, [expanded, hasRequirements, onNeedDevices]);

  const startExperience = async (experienceSlug: string): Promise<void> => {
    try {
      await client.request('experience:start', { appSlug: app.manifest.slug, experienceSlug });
      const { display, mode } = await pickDisplayForApp(client, app.manifest.slug);
      if (display) {
        await window.gosai?.appHost.open({
          displayId: display.id,
          appSlug: app.manifest.slug,
          experienceSlug,
          fullscreen: mode !== 'windowed',
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
      await stopExperienceFully(client, app.manifest.slug, experienceSlug);
    } catch (err) {
      if (!isNotConnectedError(err)) {
        onError(err instanceof Error ? err.message : String(err));
      }
    }
  };

  const stopApp = async (): Promise<void> => {
    try {
      await stopAllAppExperiences(client, app.manifest.slug, running);
    } catch (err) {
      if (!isNotConnectedError(err)) {
        onError(err instanceof Error ? err.message : String(err));
      }
    }
  };

  const calibrate = async (): Promise<void> => {
    if (calibrating) return;
    setCalibrating(true);
    try {
      await runCalibrationWizard(client, app.manifest.slug);
    } catch (err) {
      if (!isNotConnectedError(err)) onError(err instanceof Error ? err.message : String(err));
    } finally {
      setCalibrating(false);
    }
  };

  return (
    <li className="bg-neutral-900/40">
      <div className="flex items-center gap-3 px-4 py-3">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
          aria-expanded={expanded}
        >
          <span
            className={`shrink-0 text-neutral-500 transition-transform ${
              expanded ? 'rotate-90' : ''
            }`}
            aria-hidden
          >
            ▸
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="flex items-center gap-2">
              <span className="truncate text-sm font-medium text-neutral-100">
                {app.manifest.name}
              </span>
              {app.manifest.builtin ? (
                <span className="rounded bg-neutral-800 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-neutral-400">
                  built-in
                </span>
              ) : null}
              {anyRunning ? (
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-green-500" title="running" />
              ) : null}
            </span>
            <span className="truncate font-mono text-[11px] text-neutral-500">
              {app.manifest.slug} v{app.manifest.version}
              {anyRunning ? ` · running: ${running.map((r) => r.experienceSlug).join(', ')}` : ''}
            </span>
          </span>
        </button>

        {needsCalibration ? (
          <CalibrationControl status={calStatus} busy={calibrating} onClick={() => void calibrate()} />
        ) : null}

        {defaultExp ? (
          <button
            type="button"
            onClick={() => (anyRunning ? void stopApp() : void startExperience(defaultExp.slug))}
            className={`shrink-0 rounded border px-4 py-1.5 text-sm font-medium transition-colors ${
              anyRunning
                ? 'border-red-900/50 bg-red-950/40 text-red-200 hover:bg-red-900/40'
                : 'border-green-900/50 bg-green-950/40 text-green-200 hover:bg-green-900/40'
            }`}
            title={anyRunning ? 'Stop' : `Start ${defaultExp.name}`}
          >
            {anyRunning ? (running.length > 1 ? 'Stop all' : 'Stop') : 'Start'}
          </button>
        ) : (
          <span className="shrink-0 rounded border border-neutral-800 bg-neutral-950/50 px-3 py-1.5 text-xs text-neutral-500">
            no experiences
          </span>
        )}
      </div>

      {expanded ? (
        <div className="space-y-4 border-t border-neutral-800 bg-neutral-950/40 px-4 py-3 pl-9">
          {app.manifest.description ? (
            <p className="text-xs text-neutral-400">{app.manifest.description}</p>
          ) : null}

          {experiences.length > 1 ? (
            <div className="space-y-1.5">
              <p className="font-mono text-[10px] uppercase tracking-wider text-neutral-500">
                experiences
              </p>
              {experiences.map((exp) => {
                const isRunning = running.some((r) => r.experienceSlug === exp.slug);
                const isDefault = exp.slug === (app.manifest.default ?? experiences[0]?.slug);
                return (
                  <div
                    key={exp.slug}
                    className="flex items-center justify-between gap-3 rounded border border-neutral-800 bg-neutral-900/60 px-3 py-1.5"
                  >
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-[12px] text-neutral-100">{exp.name}</span>
                      <span className="truncate font-mono text-[10px] text-neutral-500">
                        {exp.slug}
                        {isDefault ? ' · default' : ''}
                      </span>
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        isRunning ? void stopExperience(exp.slug) : void startExperience(exp.slug)
                      }
                      className={`shrink-0 rounded border px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider transition-colors ${
                        isRunning
                          ? 'border-red-900/50 bg-red-950/40 text-red-200 hover:bg-red-900/40'
                          : 'border-green-900/50 bg-green-950/40 text-green-200 hover:bg-green-900/40'
                      }`}
                    >
                      {isRunning ? 'stop' : 'start'}
                    </button>
                  </div>
                );
              })}
            </div>
          ) : null}

          {hasRequirements ? (
            <DeviceSettingsSection
              app={app}
              requirements={requirements}
              devices={devices}
              displays={displays}
              devicesLoading={devicesLoading}
              onRescanDevices={onRescanDevices}
              onError={onError}
            />
          ) : null}

          {!app.manifest.builtin ? (
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => void onUninstall(app.manifest.slug)}
                className="font-mono text-[10px] uppercase tracking-wider text-neutral-600 hover:text-red-400"
              >
                uninstall
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function CalibrationControl({
  status,
  busy,
  onClick,
}: {
  status: CalStatus;
  busy: boolean;
  onClick(): void;
}): React.ReactElement {
  if (status === 'calibrated') {
    return (
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        title="Recalibrate this app"
        className="shrink-0 rounded border border-neutral-800 bg-neutral-900 px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-neutral-400 transition-colors hover:bg-neutral-800 disabled:opacity-50"
      >
        {busy ? 'calibrating…' : '✓ calibrated'}
      </button>
    );
  }
  // `required` (and the brief `unknown` probe window) gets a prominent button.
  const required = status === 'required';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      title="Calibrate this app"
      className={`flex shrink-0 items-center gap-1.5 rounded border px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-50 ${
        required
          ? 'border-amber-600/60 bg-amber-500/20 text-amber-100 shadow-[0_0_0_1px_rgba(245,158,11,0.15)] hover:bg-amber-500/30'
          : 'border-neutral-700 bg-neutral-800 text-neutral-300 hover:bg-neutral-700'
      }`}
    >
      {required ? <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" /> : null}
      {busy ? 'Calibrating…' : 'Calibrate'}
    </button>
  );
}

interface DeviceSettingsSectionProps {
  app: InstalledApp;
  requirements: NonNullable<InstalledApp['manifest']['requirements']>;
  devices: DeviceCatalog | null;
  displays: DisplayChoice[] | null;
  devicesLoading: boolean;
  onRescanDevices(): void;
  onError(msg: string): void;
}

function DeviceSettingsSection({
  app,
  requirements,
  devices,
  displays,
  devicesLoading,
  onRescanDevices,
  onError,
}: DeviceSettingsSectionProps): React.ReactElement {
  const { client } = useServer();
  const appSlug = app.manifest.slug;
  const [settings, setSettings] = useState<AppDeviceSettings>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const needsDeviceProbe =
    !!requirements.camera || !!requirements.microphone || !!requirements.speaker;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      try {
        const s = (await client.request('app:config:get', { appSlug })) as AppDeviceSettings;
        if (!cancelled) setSettings(s ?? {});
      } catch (err) {
        if (!cancelled && !isNotConnectedError(err)) {
          onError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, appSlug, onError]);

  const save = async (patch: AppDeviceSettingsPatch): Promise<void> => {
    setSaving(true);
    try {
      const next = (await client.request('app:config:set', {
        appSlug,
        settings: patch,
      })) as AppDeviceSettings;
      setSettings(next);
    } catch (err) {
      if (!isNotConnectedError(err)) {
        onError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setSaving(false);
    }
  };

  const mode: DisplayMode = settings.display?.mode ?? 'fullscreen';
  const scanning = needsDeviceProbe && devicesLoading && devices === null;

  return (
    <div className="space-y-3 rounded border border-neutral-800 bg-neutral-950/60 p-3">
      <div className="flex items-center justify-between">
        <p className="font-mono text-[10px] uppercase tracking-wider text-neutral-500">
          device assignments
        </p>
        {needsDeviceProbe ? (
          <button
            type="button"
            onClick={onRescanDevices}
            disabled={devicesLoading}
            className="font-mono text-[10px] uppercase tracking-wider text-neutral-500 transition-colors hover:text-neutral-300 disabled:opacity-50"
          >
            {devicesLoading ? 'scanning…' : 'rescan'}
          </button>
        ) : null}
      </div>
      {loading ? (
        <p className="font-mono text-[11px] text-neutral-500">Loading…</p>
      ) : (
        <div className="space-y-3">
          {requirements.display ? (
            <div className="space-y-1.5">
              <DeviceSelect
                label="Display"
                value={settings.display?.id ?? null}
                allowDefault
                defaultLabel="Default (primary)"
                options={(displays ?? []).map((d) => ({
                  index: d.id,
                  label: `${d.label}${d.primary ? ' · primary' : ''}`,
                }))}
                disabled={saving}
                onChange={(id) => void save({ display: { id, mode } })}
              />
              <div className="flex gap-1.5">
                {(['fullscreen', 'windowed'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    disabled={saving}
                    onClick={() =>
                      void save({ display: { id: settings.display?.id ?? null, mode: m } })
                    }
                    className={`flex-1 rounded border px-2 py-1 font-mono text-[10px] uppercase tracking-wider transition-colors disabled:opacity-50 ${
                      mode === m
                        ? 'border-green-900/50 bg-green-950/40 text-green-200'
                        : 'border-neutral-700 bg-neutral-900 text-neutral-400 hover:bg-neutral-800'
                    }`}
                  >
                    {m}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {requirements.camera ? (
            <DeviceSelect
              label="Camera"
              value={settings.camera?.device ?? null}
              allowDefault
              defaultLabel={scanning ? 'Scanning…' : 'Default'}
              options={devices?.cameras ?? []}
              disabled={saving}
              onChange={(device) => void save({ camera: { ...settings.camera, device: device ?? 0 } })}
            />
          ) : null}

          {requirements.microphone ? (
            <DeviceSelect
              label="Microphone"
              value={settings.microphone?.device ?? null}
              allowDefault
              defaultLabel={scanning ? 'Scanning…' : 'System default'}
              options={devices?.microphones ?? []}
              disabled={saving}
              onChange={(device) => void save({ microphone: { ...settings.microphone, device } })}
            />
          ) : null}

          {requirements.speaker ? (
            <DeviceSelect
              label="Speaker"
              value={settings.speaker?.device ?? null}
              allowDefault
              defaultLabel={scanning ? 'Scanning…' : 'System default'}
              options={devices?.speakers ?? []}
              disabled={saving}
              onChange={(device) => void save({ speaker: { ...settings.speaker, device } })}
            />
          ) : null}
        </div>
      )}
    </div>
  );
}

interface DeviceSelectProps {
  label: string;
  value: number | null;
  options: ReadonlyArray<{ index: number; label: string }>;
  allowDefault?: boolean;
  defaultLabel?: string;
  disabled?: boolean;
  onChange(value: number | null): void;
}

function DeviceSelect({
  label,
  value,
  options,
  allowDefault = false,
  defaultLabel = 'Default',
  disabled = false,
  onChange,
}: DeviceSelectProps): React.ReactElement {
  // Surface a stored device even if enumeration did not return it (e.g. unplugged).
  const knownIndices = new Set(options.map((o) => o.index));
  const showMissing = value != null && !knownIndices.has(value);
  return (
    <label className="flex items-center justify-between gap-3">
      <span className="font-mono text-[10px] uppercase tracking-wider text-neutral-500">
        {label}
      </span>
      <select
        value={value == null ? '' : String(value)}
        disabled={disabled}
        onChange={(e) => {
          const raw = e.target.value;
          onChange(raw === '' ? null : Number.parseInt(raw, 10));
        }}
        className="min-w-[180px] flex-1 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 font-mono text-[11px] text-neutral-100 disabled:opacity-50"
      >
        {allowDefault ? <option value="">{defaultLabel}</option> : null}
        {options.map((o) => (
          <option key={o.index} value={String(o.index)}>
            {o.label}
          </option>
        ))}
        {showMissing ? <option value={String(value)}>Device {value} (not detected)</option> : null}
      </select>
    </label>
  );
}
