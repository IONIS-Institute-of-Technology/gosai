import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CameraFormat, CameraFormatsResult, GlobalConfig } from '@gosai/shared';
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

function formatKey(width: number, height: number): string {
  return `${width}x${height}`;
}

export function SettingsPanel(): React.ReactElement {
  const { client, status } = useServer();
  const [config, setConfig] = useState<GlobalConfig | null>(null);
  const [displays, setDisplays] = useState<DisplaySummary[]>([]);
  const [primaryId, setPrimaryId] = useState<number | null>(null);
  const [formats, setFormats] = useState<readonly CameraFormat[] | null>(null);
  const [formatsError, setFormatsError] = useState<string | null>(null);
  const [probingFormats, setProbingFormats] = useState(false);
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

  const probeFormats = useCallback(
    async (device: number) => {
      setProbingFormats(true);
      setFormatsError(null);
      try {
        const result = (await client.request('driver:execute', {
          driver: 'camera',
          action: 'list_formats',
          data: { device },
        })) as CameraFormatsResult;
        if (!result.ok || !result.formats?.length) {
          setFormats(null);
          setFormatsError(result.error ?? 'No supported camera modes detected');
          return;
        }
        setFormats(result.formats);
      } catch (err) {
        if (!isNotConnectedError(err)) {
          setFormats(null);
          setFormatsError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        setProbingFormats(false);
      }
    },
    [client],
  );

  useEffect(() => {
    if (status === 'connected') void refresh();
  }, [status, refresh]);

  useEffect(() => {
    if (status !== 'connected' || !config) return;
    void probeFormats(config.camera.device);
  }, [status, config?.camera.device, probeFormats]);

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

  const selectedFormat = useMemo(() => {
    if (!config || !formats) return undefined;
    return formats.find(
      (f) => f.width === config.camera.width && f.height === config.camera.height,
    );
  }, [config, formats]);

  const fpsOptions = useMemo(() => {
    if (selectedFormat) return selectedFormat.fps;
    return config ? [config.camera.fps] : [];
  }, [selectedFormat, config]);

  const resolutionOptions = useMemo(() => {
    if (!config) return formats ?? [];
    const list = formats ? [...formats] : [];
    const hasCurrent = list.some(
      (f) => f.width === config.camera.width && f.height === config.camera.height,
    );
    if (!hasCurrent) {
      list.unshift({
        width: config.camera.width,
        height: config.camera.height,
        fps: [config.camera.fps],
      });
    }
    return list;
  }, [config, formats]);

  const updateCamera = (patch: Partial<GlobalConfig['camera']>): void => {
    if (!config) return;
    void updateConfig({ camera: { ...config.camera, ...patch } });
  };

  const onResolutionChange = (value: string): void => {
    const [w, h] = value.split('x').map((n) => Number.parseInt(n, 10));
    if (!Number.isFinite(w) || !Number.isFinite(h)) return;
    const format = formats?.find((f) => f.width === w && f.height === h);
    const fps =
      format && format.fps.includes(config?.camera.fps ?? 0)
        ? (config?.camera.fps ?? format.fps[0])
        : format?.fps[0];
    updateCamera({ width: w, height: h, ...(fps !== undefined ? { fps } : {}) });
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

      <Panel title="Camera">
        {error ? <p className="mb-3 font-mono text-xs text-red-400">{error}</p> : null}
        {!config ? (
          <EmptyState message="Loading configuration…" />
        ) : (
          <div className="space-y-4">
            <p className="text-xs text-neutral-400">
              Resolution and frame rate apply the next time the camera driver starts, and
              immediately when it is already running.
            </p>
            {formatsError ? (
              <p className="font-mono text-xs text-amber-400">{formatsError}</p>
            ) : null}
            {probingFormats && !formats ? (
              <p className="font-mono text-xs text-neutral-500">Detecting supported modes…</p>
            ) : null}
            <div className="grid max-w-md gap-4 sm:grid-cols-2">
              <label className="block space-y-1">
                <span className="font-mono text-[10px] uppercase tracking-wider text-neutral-500">
                  Resolution
                </span>
                <select
                  value={formatKey(config.camera.width, config.camera.height)}
                  onChange={(e) => onResolutionChange(e.target.value)}
                  disabled={saving || probingFormats || resolutionOptions.length === 0}
                  className="w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2 font-mono text-xs text-neutral-100 disabled:opacity-50"
                >
                  {resolutionOptions.length === 0 ? (
                    <option value={formatKey(config.camera.width, config.camera.height)}>
                      {config.camera.width}×{config.camera.height}
                    </option>
                  ) : (
                    resolutionOptions.map((f) => (
                      <option key={formatKey(f.width, f.height)} value={formatKey(f.width, f.height)}>
                        {f.width}×{f.height}
                      </option>
                    ))
                  )}
                </select>
              </label>
              <label className="block space-y-1">
                <span className="font-mono text-[10px] uppercase tracking-wider text-neutral-500">
                  Frame rate
                </span>
                <select
                  value={String(config.camera.fps)}
                  onChange={(e) => updateCamera({ fps: Number.parseFloat(e.target.value) })}
                  disabled={saving || probingFormats || fpsOptions.length === 0}
                  className="w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2 font-mono text-xs text-neutral-100 disabled:opacity-50"
                >
                  {fpsOptions.map((fps) => (
                    <option key={fps} value={String(fps)}>
                      {fps} fps
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <button
              type="button"
              onClick={() => void probeFormats(config.camera.device)}
              disabled={saving || probingFormats}
              className="rounded border border-neutral-700 px-3 py-1 font-mono text-[10px] uppercase tracking-wider text-neutral-400 hover:bg-neutral-800 disabled:opacity-50"
            >
              {probingFormats ? 'refreshing…' : 'refresh modes'}
            </button>
          </div>
        )}
      </Panel>

      <Panel title="Configuration">
        {config ? (
          <dl className="grid grid-cols-2 gap-x-8 gap-y-2 font-mono text-xs">
            <dt className="text-neutral-500 uppercase tracking-wider">Display ID</dt>
            <dd className="text-neutral-200">{config.displayId ?? '—'}</dd>

            <dt className="text-neutral-500 uppercase tracking-wider">Server Port</dt>
            <dd className="text-neutral-200">{config.serverPort}</dd>

            <dt className="text-neutral-500 uppercase tracking-wider">Camera</dt>
            <dd className="text-neutral-200">
              {config.camera.width}×{config.camera.height} @ {config.camera.fps} fps
            </dd>

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
