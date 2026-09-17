import type { CameraFormat } from '@gosai/shared';
import {
  findFormat,
  formatCameraMode,
  formatKey,
  resolutionPatch,
  type CameraModePatch,
} from '../../lib/camera.js';
import { Button } from './Button.js';
import { Field, SELECT_CLASS } from './Field.js';

interface CameraModePickerProps {
  /** Modes the device supports, from `useCameraFormats`. */
  readonly formats: readonly CameraFormat[] | undefined;
  readonly probing: boolean;
  readonly probeError: string | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly fps: number | null;
  readonly disabled?: boolean;
  onChange(patch: CameraModePatch): void;
  onRefresh(): void;
}

/** Resolution and frame rate pickers limited to the modes the device reported. */
export function CameraModePicker({
  formats,
  probing,
  probeError,
  width,
  height,
  fps,
  disabled = false,
  onChange,
  onRefresh,
}: CameraModePickerProps): React.ReactElement {
  const selected = findFormat(formats, width, height);
  const fpsOptions = selected ? selected.fps : fps != null ? [fps] : [];
  const placeholder = probing ? 'Detecting…' : 'Select a verified mode';
  const busy = disabled || probing;

  return (
    <div className="space-y-2">
      <Field label="Resolution">
        <select
          value={selected ? formatKey(selected.width, selected.height) : ''}
          disabled={busy || !formats?.length}
          onChange={(e) => {
            const patch = resolutionPatch(formats, e.target.value, fps);
            if (patch) onChange(patch);
          }}
          className={SELECT_CLASS}
        >
          {selected ? null : <option value="">{placeholder}</option>}
          {(formats ?? []).map((f) => (
            <option key={formatKey(f.width, f.height)} value={formatKey(f.width, f.height)}>
              {formatCameraMode(f)}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Frame rate">
        <select
          value={fps != null && fpsOptions.includes(fps) ? String(fps) : ''}
          disabled={busy || fpsOptions.length === 0}
          onChange={(e) => onChange({ fps: Number.parseFloat(e.target.value) })}
          className={SELECT_CLASS}
        >
          {fps != null && fpsOptions.includes(fps) ? null : <option value="">{placeholder}</option>}
          {fpsOptions.map((f) => (
            <option key={f} value={String(f)}>
              {f} fps
            </option>
          ))}
        </select>
      </Field>
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          {formats && width != null && height != null && !selected ? (
            <p className="font-mono text-[10px] text-amber-400">
              The current mode {width}×{height} is not verified for this device.
            </p>
          ) : null}
          {probeError ? <p className="font-mono text-[10px] text-amber-400">{probeError}</p> : null}
        </div>
        <Button variant="link" onClick={onRefresh} disabled={busy}>
          {probing ? 'detecting…' : 'refresh modes'}
        </Button>
      </div>
    </div>
  );
}
