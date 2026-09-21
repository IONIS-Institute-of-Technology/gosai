import type { AppDeviceSettingsPatch, CameraSettings, DeviceOption } from '@gosai/shared';
import { cameraDevicePatch } from '../../../lib/camera.js';
import { useCameraFormats } from '../../../lib/use-camera-formats.js';
import { CameraFocusControl } from '../../components/CameraFocusControl.js';
import { CameraModePicker } from '../../components/CameraModePicker.js';
import { DeviceSelect } from './DeviceSelect.js';

interface CameraSettingsControlsProps {
  /** The app's camera overrides. */
  readonly camera: Partial<CameraSettings> | undefined;
  /** The global camera, which supplies what the app doesn't override. */
  readonly defaults: CameraSettings | undefined;
  readonly options: readonly DeviceOption[];
  readonly scanning: boolean;
  readonly saving: boolean;
  onSave(patch: AppDeviceSettingsPatch): void;
}

/**
 * Per-app camera: device, resolution, frame rate and focus. The modes come from the
 * camera the app would use, so each app only offers what its device supports.
 */
export function CameraSettingsControls({
  camera,
  defaults,
  options,
  scanning,
  saving,
  onSave,
}: CameraSettingsControlsProps): React.ReactElement {
  const device = camera?.device ?? defaults?.device;
  const formats = useCameraFormats(device);

  return (
    <div className="space-y-2">
      <DeviceSelect
        label="Camera"
        value={camera?.device ?? null}
        defaultLabel={
          scanning ? 'Scanning…' : `Default${defaults ? ` (device ${defaults.device})` : ''}`
        }
        options={options}
        disabled={saving}
        onChange={(next) => onSave(cameraDevicePatch(next))}
      />
      <CameraModePicker
        formats={formats.data?.formats}
        probing={formats.loading}
        probeError={formats.error}
        width={camera?.width ?? defaults?.width ?? null}
        height={camera?.height ?? defaults?.height ?? null}
        fps={camera?.fps ?? defaults?.fps ?? null}
        disabled={saving}
        onChange={(patch) => onSave({ camera: patch })}
        onRefresh={() => void formats.reload()}
      />
      <CameraFocusControl
        info={formats.data?.focus}
        focus={camera?.focus}
        autoLabel={
          defaults?.focus != null ? `Default (manual ${defaults.focus})` : 'Default (autofocus)'
        }
        disabled={saving}
        onSave={(focus) => onSave({ camera: { focus } })}
      />
    </div>
  );
}
