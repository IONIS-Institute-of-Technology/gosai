import { useState } from 'react';
import type { GlobalConfigPatch } from '@gosai/shared';
import { requestErrorMessage } from '../../lib/errors.js';
import { useDisplays } from '../../lib/main-process.js';
import { useServer } from '../../lib/server-context.js';
import { useCameraFormats } from '../../lib/use-camera-formats.js';
import { useServerResource } from '../../lib/use-server-resource.js';
import { Button } from '../components/Button.js';
import { CameraFocusControl } from '../components/CameraFocusControl.js';
import { CameraModePicker } from '../components/CameraModePicker.js';
import { EmptyState } from '../components/EmptyState.js';
import { ErrorText } from '../components/ErrorText.js';
import { Panel } from '../components/Panel.js';

export function SettingsPanel(): React.ReactElement {
  const { client } = useServer();
  const config = useServerResource(
    { command: 'config:get' },
    { 'server:config-changed': (p) => p },
  );
  const displays = useDisplays();
  const formats = useCameraFormats(config.data?.camera.device);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const update = async (patch: GlobalConfigPatch): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      config.set(await client.request('config:set', patch));
    } catch (err) {
      setError(requestErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const current = config.data;

  return (
    <div className="space-y-6 p-6">
      <Panel title="Display">
        {!displays || displays.displays.length === 0 ? (
          <EmptyState message={displays ? 'No displays detected' : 'Loading…'} />
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-neutral-400">
              App windows open on this display unless the app has its own display assignment.
            </p>
            <ul className="space-y-2">
              {displays.displays.map((d) => {
                const selected = current?.displayId === d.id;
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
                        {d.id === displays.primary.id ? ' · primary' : ''}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant={selected ? 'start' : 'default'}
                      onClick={() => void update({ displayId: d.id })}
                      disabled={saving || selected}
                    >
                      {selected ? 'selected' : 'use'}
                    </Button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </Panel>

      <Panel title="Camera">
        <ErrorText error={error ?? config.error} />
        {!current ? (
          <EmptyState message="Loading configuration…" />
        ) : (
          <div className="max-w-lg space-y-4">
            <p className="text-xs text-neutral-400">
              Default resolution and frame rate of camera {current.camera.device}. Each app inherits
              them unless it overrides them in its own camera settings. Changes apply the next time
              the camera driver starts, and right away when it is running.
            </p>
            <CameraModePicker
              formats={formats.data?.formats}
              probing={formats.loading}
              probeError={formats.error}
              width={current.camera.width}
              height={current.camera.height}
              fps={current.camera.fps}
              disabled={saving}
              onChange={(camera) => void update({ camera })}
              onRefresh={() => void formats.reload()}
            />
            <CameraFocusControl
              info={formats.data?.focus}
              focus={current.camera.focus}
              disabled={saving}
              onSave={(focus) => void update({ camera: { focus } })}
            />
          </div>
        )}
      </Panel>

      <Panel title="Configuration">
        {current ? (
          <dl className="grid grid-cols-2 gap-x-8 gap-y-2 font-mono text-xs">
            <dt className="tracking-wider text-neutral-500 uppercase">Display ID</dt>
            <dd className="text-neutral-200">{current.displayId ?? '—'}</dd>

            <dt className="tracking-wider text-neutral-500 uppercase">Server Port</dt>
            <dd className="text-neutral-200">{current.serverPort}</dd>

            <dt className="tracking-wider text-neutral-500 uppercase">Camera</dt>
            <dd className="text-neutral-200">
              {current.camera.width}×{current.camera.height} @ {current.camera.fps} fps
            </dd>

            <dt className="tracking-wider text-neutral-500 uppercase">Auto-start Apps</dt>
            <dd className="text-neutral-200">
              {current.autoStartApps.length > 0 ? current.autoStartApps.join(', ') : '—'}
            </dd>
          </dl>
        ) : (
          <EmptyState message="Loading configuration…" />
        )}
      </Panel>
    </div>
  );
}
