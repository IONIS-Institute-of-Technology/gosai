import { useState } from 'react';
import type { Capability, InstalledApp } from '@gosai/shared';
import { capabilityChoices, sdkRangeLabel } from '../../../lib/install.js';
import { appIconUrl } from '../../../lib/server-url.js';
import { Button } from '../../components/Button.js';
import { Dialog } from '../../components/Dialog.js';
import { ErrorText } from '../../components/ErrorText.js';

export interface PermissionsRequest {
  readonly app: InstalledApp;
  /** `install` right after installing, `review` for an installed app. */
  readonly reason: 'install' | 'review';
}

interface PermissionsDialogProps {
  readonly request: PermissionsRequest | null;
  readonly saving: boolean;
  readonly error: string | null;
  onApprove(app: InstalledApp, approved: ReadonlySet<Capability>): void;
  onUninstall(app: InstalledApp): void;
  onClose(): void;
}

/**
 * Shows who made an app and what it asks for, and records which of the
 * requested capabilities the operator approves. Built-in apps hold all of
 * theirs, so their list is read-only.
 */
export function PermissionsDialog(props: PermissionsDialogProps): React.ReactElement {
  const { request, onClose } = props;
  return (
    <Dialog
      open={request !== null}
      onClose={onClose}
      width="lg"
      title={request?.reason === 'install' ? 'App installed' : 'App permissions'}
      subtitle={request ? `${request.app.manifest.slug} v${request.app.manifest.version}` : null}
    >
      {/* Keyed by app so the checkboxes start from its grants each time. */}
      {request ? (
        <PermissionsForm key={request.app.manifest.slug} {...props} request={request} />
      ) : null}
    </Dialog>
  );
}

function PermissionsForm({
  request: { app, reason },
  saving,
  error,
  onApprove,
  onUninstall,
  onClose,
}: PermissionsDialogProps & { readonly request: PermissionsRequest }): React.ReactElement {
  const { manifest } = app;
  const choices = capabilityChoices(app);
  const connect = manifest.network?.connect ?? [];
  // On install every request starts checked; a review starts from the current grants.
  const [approved, setApproved] = useState<ReadonlySet<Capability>>(
    () =>
      new Set(choices.filter((c) => reason === 'install' || c.granted).map((c) => c.capability)),
  );
  const icon = appIconUrl(manifest);
  const readOnly = app.builtin;

  const toggle = (capability: Capability, on: boolean): void => {
    const next = new Set(approved);
    if (on) next.add(capability);
    else next.delete(capability);
    setApproved(next);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        {icon ? (
          <img src={icon} alt="" className="h-12 w-12 shrink-0 rounded object-cover" />
        ) : (
          <div className="h-12 w-12 shrink-0 rounded bg-neutral-800" aria-hidden />
        )}
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-medium text-neutral-100">{manifest.name}</p>
          <p className="font-mono text-[11px] text-neutral-500">
            {manifest.author ? `by ${manifest.author}` : 'author not given'} ·{' '}
            {sdkRangeLabel(manifest)}
          </p>
          {manifest.description ? (
            <p className="text-xs text-neutral-400">{manifest.description}</p>
          ) : null}
        </div>
      </div>

      <section className="space-y-2">
        <h3 className="font-mono text-[10px] tracking-wider text-neutral-400 uppercase">
          Requested capabilities
        </h3>
        {choices.length === 0 ? (
          <p className="text-xs text-neutral-500">
            None. The app only gets what every app gets: its own storage, experiences and drivers.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {choices.map((choice) => (
              <li key={choice.capability}>
                <label className="flex items-start gap-2.5 rounded border border-neutral-800 bg-neutral-950/60 px-3 py-2">
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4 accent-green-500"
                    checked={readOnly || approved.has(choice.capability)}
                    disabled={readOnly || saving}
                    onChange={(e) => toggle(choice.capability, e.target.checked)}
                  />
                  <span className="flex min-w-0 flex-col">
                    <span className="font-mono text-xs text-neutral-100">{choice.capability}</span>
                    <span className="text-[11px] text-neutral-400">{choice.description}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </section>

      {connect.length > 0 ? (
        <section className="space-y-2">
          <h3 className="font-mono text-[10px] tracking-wider text-neutral-400 uppercase">
            Network access
          </h3>
          <p className="text-[11px] text-neutral-500">
            Besides its own origin and any https or wss address, the app&apos;s pages may connect
            to:
          </p>
          <ul className="space-y-1">
            {connect.map((origin) => (
              <li key={origin} className="font-mono text-xs text-neutral-200">
                {origin}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {readOnly ? (
        <p className="text-[11px] text-neutral-500">
          Built-in apps hold every capability they request.
        </p>
      ) : null}
      <ErrorText error={error} />

      <div className="flex items-center justify-end gap-2 border-t border-neutral-800 pt-3">
        {reason === 'install' && !readOnly ? (
          <Button variant="danger-link" className="mr-auto" onClick={() => onUninstall(app)}>
            uninstall instead
          </Button>
        ) : null}
        <Button size="sm" onClick={onClose} disabled={saving}>
          {readOnly || choices.length === 0 ? 'Close' : 'Cancel'}
        </Button>
        {readOnly || choices.length === 0 ? null : (
          <Button
            size="sm"
            variant="start"
            disabled={saving}
            onClick={() => onApprove(app, approved)}
          >
            {saving ? 'Saving…' : `Allow ${approved.size} of ${choices.length}`}
          </Button>
        )}
      </div>
    </div>
  );
}
