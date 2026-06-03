import { useCallback, useEffect, useState } from 'react';
import type { AppSettingsField, AppSettingsSchema, InstalledApp } from '@gosai/shared';

const SERVER_BASE_URL = 'http://127.0.0.1:7777';

type SettingValue = string | number | boolean;
type ConfigObject = Record<string, unknown>;

interface AppSettingsModalProps {
  app: InstalledApp;
  schema: AppSettingsSchema;
  onClose: () => void;
}

/**
 * Generic settings editor rendered from an app's declarative
 * {@link AppSettingsSchema}. Loads the current config object from the app's
 * key/value storage, lets the user edit each declared field, and writes the
 * merged object back. Field keys are dotted paths into the config object.
 */
export function AppSettingsModal({
  app,
  schema,
  onClose,
}: AppSettingsModalProps): React.ReactElement {
  const slug = app.manifest.slug;
  const storageKey = schema.storageKey ?? 'config';
  const [config, setConfig] = useState<ConfigObject>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `${SERVER_BASE_URL}/v1/apps/${slug}/storage/${encodeURIComponent(storageKey)}`,
      );
      const stored = res.status === 200 ? ((await res.json()) as ConfigObject) : {};
      setConfig(stored && typeof stored === 'object' ? stored : {});
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [slug, storageKey]);

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

  const setField = (key: string, value: SettingValue): void => {
    setConfig((prev) => setPath(prev, key, value));
    setSaved(false);
  };

  const save = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(
        `${SERVER_BASE_URL}/v1/apps/${slug}/storage/${encodeURIComponent(storageKey)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(config),
        },
      );
      if (!res.ok) throw new Error(`save failed (${res.status})`);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const resetDefaults = (): void => {
    let next: ConfigObject = {};
    for (const group of schema.groups) {
      for (const field of group.fields) {
        if (field.default !== undefined) next = setPath(next, field.key, field.default);
      }
    }
    setConfig(next);
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
                    value={getPath(config, field.key) ?? field.default}
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
  onChange: (v: SettingValue) => void;
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
  onChange: (v: SettingValue) => void;
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

// ── Dotted-path helpers ────────────────────────────────────────────────────

function getPath(obj: ConfigObject, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split('.')) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as ConfigObject)[part];
  }
  return cur;
}

/** Immutably set a dotted path, cloning objects along the way. */
function setPath(obj: ConfigObject, path: string, value: SettingValue): ConfigObject {
  const parts = path.split('.');
  const root: ConfigObject = { ...obj };
  let cur = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    const existing = cur[part];
    const next: ConfigObject =
      typeof existing === 'object' && existing !== null ? { ...(existing as ConfigObject) } : {};
    cur[part] = next;
    cur = next;
  }
  cur[parts[parts.length - 1]!] = value;
  return root;
}
