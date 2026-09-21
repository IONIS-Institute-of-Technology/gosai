import { useState } from 'react';
import type { CameraFocusInfo } from '@gosai/shared';
import { Field, SELECT_CLASS } from './Field.js';

interface CameraFocusControlProps {
  /** The device's focus control, from `useCameraFormats`. Nothing renders without one. */
  readonly info: CameraFocusInfo | null | undefined;
  /** The saved focus. `null` or absent is autofocus. */
  readonly focus: number | null | undefined;
  /** Label of the automatic option. Per-app settings use it to name the inherited value. */
  readonly autoLabel?: string;
  readonly disabled?: boolean;
  onSave(focus: number | null): void;
}

/**
 * Autofocus or a fixed manual focus. The slider saves on release, and the
 * readout follows the drag.
 */
export function CameraFocusControl({
  info,
  focus,
  autoLabel,
  disabled = false,
  onSave,
}: CameraFocusControlProps): React.ReactElement | null {
  const manual = focus != null;
  // Start from where autofocus last settled, so switching to manual keeps
  // the picture sharp instead of jumping.
  const seed = focus ?? info?.value ?? info?.default ?? 0;
  // The value under the pointer during a drag. Outside one, the saved focus shows.
  const [dragged, setDragged] = useState<number | null>(null);
  const pending = dragged ?? seed;

  if (!info) return null;
  const commit = (): void => {
    setDragged(null);
    if (pending !== focus) onSave(pending);
  };

  return (
    <div className="space-y-2">
      <Field label="Focus">
        <select
          value={manual ? 'manual' : 'auto'}
          disabled={disabled}
          onChange={(e) => onSave(e.target.value === 'manual' ? pending : null)}
          className={SELECT_CLASS}
        >
          {/* Without an autofocus control, automatic leaves the camera alone. */}
          <option value="auto">
            {autoLabel ?? (info.autofocus ? 'Autofocus' : 'Camera default')}
          </option>
          <option value="manual">Manual (fixed)</option>
        </select>
      </Field>
      {manual ? (
        <Field label="">
          <div className="flex min-w-[180px] flex-1 items-center gap-2">
            <input
              type="range"
              min={info.min}
              max={info.max}
              step={info.step}
              value={pending}
              disabled={disabled}
              onChange={(e) => setDragged(Number.parseInt(e.target.value, 10))}
              onPointerUp={commit}
              onKeyUp={commit}
              className="min-w-0 flex-1 accent-green-500 disabled:opacity-50"
            />
            <span className="w-10 text-right font-mono text-[11px] text-neutral-300">
              {pending}
            </span>
          </div>
        </Field>
      ) : null}
    </div>
  );
}
