import { useState } from 'react';
import type {
  AppSettingValue,
  AppSettingsField,
  AppSettingsSchema,
  InstalledApp,
} from '@gosai/shared';
import { getSettingValue } from '@gosai/shared/app-settings';
import { requestErrorMessage } from '../../../lib/errors.js';
import { useServer } from '../../../lib/server-context.js';
import { useServerResource } from '../../../lib/use-server-resource.js';
import { Button } from '../../components/Button.js';
import { Dialog } from '../../components/Dialog.js';
import { ErrorText } from '../../components/ErrorText.js';

/** Unsaved edits by field key. `null` restores the field's default. */
type Changes = Record<string, AppSettingValue | null>;

interface AppSettingsDialogProps {
  readonly app: InstalledApp;
  readonly schema: AppSettingsSchema;
  readonly open: boolean;
  onClose(): void;
}

/**
 * Settings editor built from the app's declared {@link AppSettingsSchema}.
 * Shows the stored values merged with their defaults and saves the edited
 * fields; the server checks each value against its field.
 */
export function AppSettingsDialog({
  app,
  schema,
  open,
  onClose,
}: AppSettingsDialogProps): React.ReactElement {
  const { client } = useServer();
  const appSlug = app.manifest.slug;
  const values = useServerResource(
    { command: 'app:settings:get', payload: { appSlug }, enabled: open },
    { 'app:settings-changed': (p) => (p.appSlug === appSlug ? p.values : undefined) },
  );
  const [changes, setChanges] = useState<Changes>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const close = (): void => {
    setChanges({});
    setSaved(false);
    setSaveError(null);
    onClose();
  };

  const setField = (key: string, value: AppSettingValue): void => {
    setChanges((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
  };

  const valueOf = (field: AppSettingsField): unknown => {
    if (!Object.hasOwn(changes, field.key)) return getSettingValue(values.data ?? {}, field.key);
    return changes[field.key] ?? field.default;
  };

  const save = async (): Promise<void> => {
    setSaving(true);
    setSaveError(null);
    try {
      values.set(await client.request('app:settings:set', { appSlug, values: changes }));
      setChanges({});
      setSaved(true);
    } catch (err) {
      setSaveError(requestErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const resetDefaults = (): void => {
    const next: Changes = {};
    for (const group of schema.groups) {
      for (const field of group.fields) next[field.key] = null;
    }
    setChanges(next);
    setSaved(false);
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title={app.manifest.name}
      subtitle="settings"
      footer={
        <>
          <Button size="sm" className="mr-auto" onClick={resetDefaults}>
            Reset to defaults
          </Button>
          {saved ? <span className="text-xs text-green-400">Saved · restart to apply</span> : null}
          <Button size="sm" onClick={close}>
            Close
          </Button>
          <Button
            size="sm"
            variant="start"
            onClick={() => void save()}
            disabled={saving || !values.data}
          >
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      {!values.data ? (
        <p className="text-sm text-neutral-500">Loading…</p>
      ) : (
        schema.groups.map((group) => (
          <section key={group.label} className="space-y-3">
            <div>
              <h3 className="font-mono text-[10px] tracking-wider text-neutral-400 uppercase">
                {group.label}
              </h3>
              {group.description ? (
                <p className="mt-0.5 text-[11px] text-neutral-500">{group.description}</p>
              ) : null}
            </div>
            {group.fields.map((field) => (
              <FieldRow
                key={field.key}
                field={field}
                value={valueOf(field)}
                onChange={(v) => setField(field.key, v)}
              />
            ))}
          </section>
        ))
      )}
      <ErrorText error={values.error ?? saveError} />
    </Dialog>
  );
}

function FieldRow({
  field,
  value,
  onChange,
}: {
  field: AppSettingsField;
  value: unknown;
  onChange: (v: AppSettingValue) => void;
}): React.ReactElement {
  return (
    <label className="flex items-start justify-between gap-4">
      <span className="flex min-w-0 flex-col">
        <span className="text-[13px] text-neutral-200">{field.label}</span>
        {field.description ? (
          <span className="text-[11px] text-neutral-500">{field.description}</span>
        ) : null}
        <span className="font-mono text-[10px] text-neutral-600">{field.key}</span>
      </span>
      <span className="shrink-0">
        <FieldInput field={field} value={value} onChange={onChange} />
      </span>
    </label>
  );
}

function FieldInput({
  field,
  value,
  onChange,
}: {
  field: AppSettingsField;
  value: unknown;
  onChange: (v: AppSettingValue) => void;
}): React.ReactElement {
  const inputClass =
    'rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-sm text-neutral-100 focus:border-neutral-500 focus:outline-none';

  if (field.type === 'boolean') {
    return (
      <input
        type="checkbox"
        checked={Boolean(value)}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 accent-green-500"
      />
    );
  }
  if (field.type === 'select') {
    return (
      <select
        value={String(value ?? '')}
        onChange={(e) => onChange(e.target.value)}
        className={inputClass}
      >
        {(field.options ?? []).map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    );
  }
  if (field.type === 'number') {
    return (
      <input
        type="number"
        value={value === undefined || value === null ? '' : Number(value)}
        min={field.min}
        max={field.max}
        step={field.step ?? 'any'}
        onChange={(e) => onChange(e.target.value === '' ? 0 : Number(e.target.value))}
        className={`${inputClass} w-24`}
      />
    );
  }
  return (
    <input
      type="text"
      value={String(value ?? '')}
      onChange={(e) => onChange(e.target.value)}
      className={`${inputClass} w-40`}
    />
  );
}
