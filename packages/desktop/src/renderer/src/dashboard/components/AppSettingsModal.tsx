import { useCallback, useEffect, useState } from 'react';
import type {
  AppSettingValue,
  AppSettingsField,
  AppSettingsSchema,
  AppSettingsValues,
  InstalledApp,
} from '@gosai/shared';
import { getSettingValue } from '@gosai/shared/app-settings';
import { isNotConnectedError } from '@gosai/shared/client';
import { useServer } from '../../lib/server-context.js';

/** Unsaved edits by field key. `null` restores the field's default. */
type Changes = Record<string, AppSettingValue | null>;

interface AppSettingsModalProps {
  app: InstalledApp;
  schema: AppSettingsSchema;
  onClose: () => void;
}

/**
 * Generic settings editor rendered from an app's declarative
 * {@link AppSettingsSchema}. Loads the app's settings merged with their
 * defaults, lets the user edit each declared field, and saves the edited
 * fields; the server checks each value against its field.
 */
export function AppSettingsModal({
  app,
  schema,
  onClose,
}: AppSettingsModalProps): React.ReactElement {
  const { client } = useServer();
  const slug = app.manifest.slug;
  const [values, setValues] = useState<AppSettingsValues>({});
  const [changes, setChanges] = useState<Changes>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      setValues(await client.request('app:settings:get', { appSlug: slug }));
      setChanges({});
    } catch (err) {
      if (!isNotConnectedError(err)) setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [client, slug]);

  useEffect(() => {
    void load();
  }, [load]);

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const setField = (key: string, value: AppSettingValue): void => {
    setChanges((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
  };

  const valueOf = (field: AppSettingsField): unknown => {
    if (!Object.hasOwn(changes, field.key)) return getSettingValue(values, field.key);
    return changes[field.key] ?? field.default;
  };

  const save = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      setValues(await client.request('app:settings:set', { appSlug: slug, values: changes }));
      setChanges({});
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="flex max-h-[85vh] w-full max-w-lg flex-col rounded-lg border border-neutral-700 bg-neutral-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`${app.manifest.name} settings`}
      >
        <header className="flex items-center justify-between border-b border-neutral-800 px-5 py-3">
          <div className="flex min-w-0 flex-col">
            <h2 className="truncate text-sm font-medium text-neutral-100">{app.manifest.name}</h2>
            <span className="font-mono text-[11px] text-neutral-500">settings</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded px-2 py-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
            aria-label="Close"
          >
            ✕
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
          {loading ? (
            <p className="text-sm text-neutral-500">Loading…</p>
          ) : (
            schema.groups.map((group) => (
              <section key={group.label} className="space-y-3">
                <div>
                  <h3 className="font-mono text-[10px] uppercase tracking-wider text-neutral-400">
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
          {error ? <p className="text-xs text-red-400">{error}</p> : null}
        </div>

        <footer className="flex items-center justify-between gap-2 border-t border-neutral-800 px-5 py-3">
          <button
            type="button"
            onClick={resetDefaults}
            className="rounded border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-800"
          >
            Reset to defaults
          </button>
          <div className="flex items-center gap-2">
            {saved ? (
              <span className="text-xs text-green-400">Saved · restart to apply</span>
            ) : null}
            <button
              type="button"
              onClick={onClose}
              className="rounded border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-800"
            >
              Close
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving || loading}
              className="rounded border border-green-900/50 bg-green-950/40 px-4 py-1.5 text-xs font-medium text-green-200 hover:bg-green-900/40 disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </footer>
      </div>
    </div>
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
