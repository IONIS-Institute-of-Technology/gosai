import { useState } from 'react';
import type {
  AppDeviceSettingsPatch,
  AppRequirements,
  DeviceCatalog,
  DisplayMode,
} from '@gosai/shared';
import { requestErrorMessage } from '../../../lib/errors.js';
import { useDisplays } from '../../../lib/main-process.js';
import { useServer } from '../../../lib/server-context.js';
import { useServerResource } from '../../../lib/use-server-resource.js';
import { Button } from '../../components/Button.js';
import { ErrorText } from '../../components/ErrorText.js';
import { CameraSettingsControls } from './CameraSettingsControls.js';
import { DeviceSelect } from './DeviceSelect.js';

interface DeviceSettingsSectionProps {
  readonly appSlug: string;
  readonly requirements: AppRequirements;
  /** Shared by every row, and only probed once a row needs it. */
  readonly devices: DeviceCatalog | undefined;
  readonly devicesLoading: boolean;
  onRescanDevices(): void;
}

/** The app's display, camera, microphone and speaker assignments. */
export function DeviceSettingsSection({
  appSlug,
  requirements,
  devices,
  devicesLoading,
  onRescanDevices,
}: DeviceSettingsSectionProps): React.ReactElement {
  const { client } = useServer();
  const displays = useDisplays();
  const settings = useServerResource(
    { command: 'app:config:get', payload: { appSlug } },
    { 'app:config-changed': (p) => (p.appSlug === appSlug ? p.settings : undefined) },
  );
  // The global camera supplies what the app doesn't override.
  const config = useServerResource(
    { command: 'config:get', enabled: !!requirements.camera },
    { 'server:config-changed': (p) => p },
  );
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const needsDeviceProbe =
    !!requirements.camera || !!requirements.microphone || !!requirements.speaker;
  const scanning = needsDeviceProbe && devicesLoading && devices === undefined;
  const current = settings.data;
  const mode: DisplayMode = current?.display?.mode ?? 'fullscreen';

  const save = async (patch: AppDeviceSettingsPatch): Promise<void> => {
    setSaving(true);
    setSaveError(null);
    try {
      settings.set(await client.request('app:config:set', { appSlug, settings: patch }));
    } catch (err) {
      setSaveError(requestErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3 rounded border border-neutral-800 bg-neutral-950/60 p-3">
      <div className="flex items-center justify-between">
        <p className="font-mono text-[10px] tracking-wider text-neutral-500 uppercase">
          device assignments
        </p>
        {needsDeviceProbe ? (
          <Button variant="link" onClick={onRescanDevices} disabled={devicesLoading}>
            {devicesLoading ? 'scanning…' : 'rescan'}
          </Button>
        ) : null}
      </div>
      <ErrorText error={settings.error ?? saveError} />
      {!current ? (
        <p className="font-mono text-[11px] text-neutral-500">Loading…</p>
      ) : (
        <div className="space-y-3">
          {requirements.display ? (
            <div className="space-y-1.5">
              <DeviceSelect
                label="Display"
                value={current.display?.id ?? null}
                defaultLabel="Default (global display)"
                options={(displays?.displays ?? []).map((d) => ({
                  index: d.id,
                  label: `${d.label}${d.primary ? ' · primary' : ''}`,
                }))}
                disabled={saving}
                onChange={(id) => void save({ display: { id, mode } })}
              />
              <div className="flex gap-1.5">
                {(['fullscreen', 'windowed'] as const).map((m) => (
                  <Button
                    key={m}
                    size="sm"
                    variant={mode === m ? 'start' : 'default'}
                    className="flex-1"
                    disabled={saving}
                    aria-pressed={mode === m}
                    onClick={() => void save({ display: { mode: m } })}
                  >
                    {m}
                  </Button>
                ))}
              </div>
            </div>
          ) : null}

          {requirements.camera ? (
            <CameraSettingsControls
              camera={current.camera}
              defaults={config.data?.camera}
              options={devices?.cameras ?? []}
              scanning={scanning}
              saving={saving}
              onSave={(patch) => void save(patch)}
            />
          ) : null}

          {requirements.microphone ? (
            <DeviceSelect
              label="Microphone"
              value={current.microphone?.device ?? null}
              defaultLabel={scanning ? 'Scanning…' : 'System default'}
              options={devices?.microphones ?? []}
              disabled={saving}
              onChange={(device) => void save({ microphone: { device } })}
            />
          ) : null}

          {requirements.speaker ? (
            <DeviceSelect
              label="Speaker"
              value={current.speaker?.device ?? null}
              defaultLabel={scanning ? 'Scanning…' : 'System default'}
              options={devices?.speakers ?? []}
              disabled={saving}
              onChange={(device) => void save({ speaker: { device } })}
            />
          ) : null}
        </div>
      )}
    </div>
  );
}
