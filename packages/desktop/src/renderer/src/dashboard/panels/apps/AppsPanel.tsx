import { useState } from 'react';
import type { Capability, InstalledApp } from '@gosai/shared';
import { CALIBRATION_RUNNER } from '@gosai/shared/calibration';
import { requestErrorMessage } from '../../../lib/errors.js';
import { installApp, saveCapabilityGrants } from '../../../lib/install.js';
import { useServer } from '../../../lib/server-context.js';
import { useServerResource } from '../../../lib/use-server-resource.js';
import { Button } from '../../components/Button.js';
import { Dialog } from '../../components/Dialog.js';
import { EmptyState } from '../../components/EmptyState.js';
import { ErrorText } from '../../components/ErrorText.js';
import { Panel } from '../../components/Panel.js';
import { AppRow } from './AppRow.js';
import { PermissionsDialog, type PermissionsRequest } from './PermissionsDialog.js';
import { UninstallDialog, type UninstallRequest } from './UninstallDialog.js';

interface ReuseDataPrompt {
  readonly message: string;
  resolve(reuse: boolean): void;
}

export function AppsPanel(): React.ReactElement {
  const { client } = useServer();
  const apps = useServerResource({ command: 'apps:list' }, { 'apps:list-changed': (p) => p });
  const running = useServerResource(
    { command: 'experiences:list', select: (r) => r.experiences },
    { 'experiences:list-changed': (p) => p.experiences },
  );
  // Probing hardware is slow, so it waits until a row that needs devices opens.
  const [devicesWanted, setDevicesWanted] = useState(false);
  const devices = useServerResource({ command: 'devices:list', enabled: devicesWanted });

  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState('');
  const [installing, setInstalling] = useState(false);
  const [reusePrompt, setReusePrompt] = useState<ReuseDataPrompt | null>(null);
  const [permissions, setPermissions] = useState<PermissionsRequest | null>(null);
  const [permissionsSaving, setPermissionsSaving] = useState(false);
  const [permissionsError, setPermissionsError] = useState<string | null>(null);
  const [uninstall, setUninstall] = useState<UninstallRequest | null>(null);
  const [uninstalling, setUninstalling] = useState(false);
  const [uninstallError, setUninstallError] = useState<string | null>(null);

  const install = async (): Promise<void> => {
    const trimmed = source.trim();
    if (!trimmed) return;
    setInstalling(true);
    setError(null);
    try {
      const installed = await installApp(
        client,
        trimmed,
        (message) => new Promise((resolve) => setReusePrompt({ message, resolve })),
      );
      if (!installed) return;
      setSource('');
      openPermissions({ app: installed, reason: 'install' });
    } catch (err) {
      setError(requestErrorMessage(err));
    } finally {
      setInstalling(false);
    }
  };

  const answerReuse = (reuse: boolean): void => {
    reusePrompt?.resolve(reuse);
    setReusePrompt(null);
  };

  const openPermissions = (request: PermissionsRequest): void => {
    setPermissionsError(null);
    setPermissions(request);
  };

  const approve = async (app: InstalledApp, approved: ReadonlySet<Capability>): Promise<void> => {
    setPermissionsSaving(true);
    setPermissionsError(null);
    try {
      await saveCapabilityGrants(client, app, approved);
      setPermissions(null);
    } catch (err) {
      setPermissionsError(requestErrorMessage(err));
    } finally {
      setPermissionsSaving(false);
    }
  };

  const openUninstall = (request: UninstallRequest): void => {
    setPermissions(null);
    setUninstallError(null);
    setUninstall(request);
  };

  const confirmUninstall = async (slug: string, deleteData: boolean): Promise<void> => {
    setUninstalling(true);
    setUninstallError(null);
    try {
      await client.request('app:uninstall', { slug, deleteData });
      setUninstall(null);
    } catch (err) {
      setUninstallError(requestErrorMessage(err));
    } finally {
      setUninstalling(false);
    }
  };

  const userApps = (apps.data?.apps ?? []).filter(
    (app) => app.manifest.slug !== CALIBRATION_RUNNER.appSlug,
  );
  const invalidApps = apps.data?.invalid ?? [];

  return (
    <div className="space-y-6 p-6">
      <Panel title="Install an app">
        <div className="space-y-3">
          <p className="text-xs text-neutral-400">
            Paste a git repository URL containing a{' '}
            <code className="font-mono">gosai.app.json</code>. You choose what it may access once it
            is installed.
          </p>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void install();
            }}
          >
            <input
              type="text"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              placeholder="https://github.com/owner/repo.git"
              className="flex-1 rounded border border-neutral-800 bg-neutral-950 px-3 py-2 font-mono text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none"
              spellCheck={false}
            />
            <Button type="submit" className="px-4 py-2" disabled={installing || !source.trim()}>
              {installing ? 'Installing…' : 'Install'}
            </Button>
          </form>
          <ErrorText error={error ?? apps.error} />
        </div>
      </Panel>

      <Panel title={`Installed (${userApps.length})`}>
        {userApps.length === 0 ? (
          <EmptyState message={apps.data ? 'No apps installed yet' : 'Loading…'} />
        ) : (
          <ul className="divide-y divide-neutral-800 overflow-hidden rounded border border-neutral-800">
            {userApps.map((app) => (
              <AppRow
                key={app.manifest.slug}
                app={app}
                running={(running.data ?? []).filter((r) => r.appSlug === app.manifest.slug)}
                devices={devices.data}
                devicesLoading={devices.loading}
                onNeedDevices={() => setDevicesWanted(true)}
                onRescanDevices={() => void devices.reload()}
                onReviewPermissions={(app) => openPermissions({ app, reason: 'review' })}
                onUninstall={(app) =>
                  openUninstall({ slug: app.manifest.slug, name: app.manifest.name })
                }
                onError={setError}
              />
            ))}
          </ul>
        )}
      </Panel>

      {invalidApps.length > 0 ? (
        <Panel title={`Invalid (${invalidApps.length})`}>
          <ul className="divide-y divide-neutral-800 overflow-hidden rounded border border-neutral-800">
            {invalidApps.map((invalid) => (
              <li key={invalid.slug} className="flex items-start gap-3 bg-neutral-900/40 px-4 py-3">
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="font-mono text-sm text-neutral-100">{invalid.slug}</span>
                  <span className="font-mono text-[11px] break-words text-red-300">
                    {invalid.error}
                  </span>
                </span>
                {invalid.builtin ? null : (
                  <Button
                    variant="danger-link"
                    onClick={() => openUninstall({ slug: invalid.slug, name: invalid.slug })}
                  >
                    uninstall
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      <Dialog
        open={reusePrompt !== null}
        onClose={() => answerReuse(false)}
        title="Reuse existing app data?"
        footer={
          <>
            <Button size="sm" onClick={() => answerReuse(false)}>
              Cancel install
            </Button>
            <Button size="sm" variant="warning" onClick={() => answerReuse(true)}>
              Install and reuse
            </Button>
          </>
        }
      >
        <p className="text-xs break-words text-neutral-300">{reusePrompt?.message}</p>
        <p className="text-xs text-neutral-500">
          Reusing gives this app the storage and settings the earlier app left.
        </p>
      </Dialog>

      <PermissionsDialog
        request={permissions}
        saving={permissionsSaving}
        error={permissionsError}
        onApprove={(app, approved) => void approve(app, approved)}
        onUninstall={(app) => openUninstall({ slug: app.manifest.slug, name: app.manifest.name })}
        onClose={() => setPermissions(null)}
      />

      <UninstallDialog
        request={uninstall}
        busy={uninstalling}
        error={uninstallError}
        onConfirm={(slug, deleteData) => void confirmUninstall(slug, deleteData)}
        onClose={() => setUninstall(null)}
      />
    </div>
  );
}
