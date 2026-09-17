import type { DeviceOption } from '@gosai/shared';
import { deviceFromSelectValue, deviceToSelectValue } from '../../../lib/devices.js';
import { Field, SELECT_CLASS } from '../../components/Field.js';

interface DeviceSelectProps {
  readonly label: string;
  /** The assigned device, or `null` for the default one. */
  readonly value: number | null;
  readonly options: readonly Pick<DeviceOption, 'index' | 'label'>[];
  readonly defaultLabel: string;
  readonly disabled?: boolean;
  /** `null` when the operator picks the default entry. */
  onChange(value: number | null): void;
}

export function DeviceSelect({
  label,
  value,
  options,
  defaultLabel,
  disabled = false,
  onChange,
}: DeviceSelectProps): React.ReactElement {
  // Keep a stored device selectable even when enumeration missed it (unplugged).
  const missing = value != null && !options.some((o) => o.index === value);
  return (
    <Field label={label}>
      <select
        value={deviceToSelectValue(value)}
        disabled={disabled}
        onChange={(e) => onChange(deviceFromSelectValue(e.target.value))}
        className={SELECT_CLASS}
      >
        <option value="">{defaultLabel}</option>
        {options.map((o) => (
          <option key={o.index} value={String(o.index)}>
            {o.label}
          </option>
        ))}
        {missing ? <option value={String(value)}>Device {value} (not detected)</option> : null}
      </select>
    </Field>
  );
}
