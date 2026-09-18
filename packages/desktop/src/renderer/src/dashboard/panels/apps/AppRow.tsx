import { useState } from 'react';
import type { DeviceCatalog, InstalledApp, RunningExperience } from '@gosai/shared';
import { readyToStart } from '../../../lib/calibration-gate.js';
import { requestErrorMessage } from '../../../lib/errors.js';
import { hasPermissionRequests, sdkRangeLabel } from '../../../lib/install.js';
import { useServer } from '../../../lib/server-context.js';
import { RELOAD } from '../../../lib/server-resource.js';
import { appIconUrl } from '../../../lib/server-url.js';
import { useServerResource } from '../../../lib/use-server-resource.js';
import { Button } from '../../components/Button.js';
import { AppSettingsDialog } from './AppSettingsDialog.js';
import { DeviceSettingsSection } from './DeviceSettingsSection.js';

type CalibrationStatus = 'unknown' | 'calibrated' | 'uncalibrated';

interface AppRowProps {
  readonly app: InstalledApp;
  /** The app's running experiences. */
  readonly running: readonly RunningExperience[];
  readonly devices: DeviceCatalog | undefined;
  readonly devicesLoading: boolean;
  onNeedDevices(): void;
  onRescanDevices(): void;
  onReviewPermissions(app: InstalledApp): void;
  onUninstall(app: InstalledApp): void;
  onError(message: string | null): void;
}

export function AppRow({
  app,
  running,
  devices,
  devicesLoading,
  onNeedDevices,
  onRescanDevices,
  onReviewPermissions,
  onUninstall,
  onError,
}: AppRowProps): React.ReactElement {
  const { client } = useServer();
  const { manifest } = app;
  const appSlug = manifest.slug;
  const [expanded, setExpanded] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [calibrating, setCalibrating] = useState(false);

  const requirements = manifest.requirements ?? {};
  const hasRequirements =
    !!requirements.display ||
    !!requirements.camera ||
    !!requirements.microphone ||
    !!requirements.speaker;
  const needsDevices = !!requirements.camera || !!requirements.microphone || !!requirements.speaker;
  const hasCalibration = manifest.calibration !== undefined;
  const requiresCalibration = manifest.calibration?.required === true;
  // A custom calibration experience runs through Calibrate, not as a normal experience.
  const experiences = manifest.experiences.filter(
    (e) => e.slug !== manifest.calibration?.experience,
  );
  const defaultExperience = experiences.find((e) => e.slug === manifest.default) ?? experiences[0];
  const anyRunning = running.length > 0;

  // Saves from anywhere refresh it: this row, a kiosk, or the app's own flow.
  const calibration = useServerResource(
    { command: 'calibration:get', payload: { appSlug }, enabled: hasCalibration },
    { 'calibration:changed': (p) => (p.appSlug === appSlug ? RELOAD : undefined) },
  );
  const calibrationStatus: CalibrationStatus = calibration.data
    ? calibration.data.calibrated
      ? 'calibrated'
      : 'uncalibrated'
    : calibration.error
      ? 'uncalibrated'
      : 'unknown';

  const run = async (action: () => Promise<unknown>): Promise<void> => {
    onError(null);
    try {
      await action();
    } catch (err) {
      onError(requestErrorMessage(err));
    }
  };

  /** Runs the calibration flow. Resolves with whether it saved a profile. */
  const calibrate = async (): Promise<boolean> => {
    if (calibrating) return false;
    setCalibrating(true);
    try {
      const result = await window.gosai.calibration.run({ appSlug });
      if (!result.ok && !result.cancelled) onError(`Calibration failed: ${result.error}`);
      return result.ok;
    } finally {
      setCalibrating(false);
      void calibration.reload();
    }
  };

  // Main opens the window once the server reports the experience running.
  const start = (experienceSlug: string): Promise<void> =>
    run(async () => {
      const ready = await readyToStart({
        required: requiresCalibration,
        isCalibrated: async () => (await calibration.reload())?.calibrated === true,
        calibrate,
      });
      if (ready) await client.request('experience:start', { appSlug, experienceSlug });
    });

  const stop = (experienceSlugs: readonly string[]): Promise<void> =>
    run(() =>
      Promise.all(
        experienceSlugs.map((experienceSlug) =>
          client.request('experience:stop', { appSlug, experienceSlug }),
        ),
      ),
    );

  const toggleExpanded = (): void => {
    if (!expanded && needsDevices) onNeedDevices();
    setExpanded(!expanded);
  };

  const icon = appIconUrl(manifest);

  return (
    <li className="bg-neutral-900/40">
      <div className="flex items-center gap-3 px-4 py-3">
        <button
          type="button"
          onClick={toggleExpanded}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
          aria-expanded={expanded}
        >
          <span
            className={`shrink-0 text-neutral-500 transition-transform ${expanded ? 'rotate-90' : ''}`}
            aria-hidden
          >
            ▸
          </span>
          {icon ? (
            <img src={icon} alt="" className="h-8 w-8 shrink-0 rounded object-cover" />
          ) : null}
          <span className="flex min-w-0 flex-col">
            <span className="flex items-center gap-2">
              <span className="truncate text-sm font-medium text-neutral-100">{manifest.name}</span>
              {app.builtin ? (
                <span className="rounded bg-neutral-800 px-1.5 py-0.5 font-mono text-[10px] tracking-wider text-neutral-400 uppercase">
                  built-in
                </span>
              ) : null}
              {anyRunning ? (
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-green-500" title="running" />
              ) : null}
            </span>
            <span className="truncate font-mono text-[11px] text-neutral-500">
              {appSlug} v{manifest.version}
              {manifest.author ? ` · by ${manifest.author}` : ''}
              {manifest.sdk === undefined ? '' : ` · ${sdkRangeLabel(manifest)}`}
              {anyRunning ? ` · running: ${running.map((r) => r.experienceSlug).join(', ')}` : ''}
            </span>
            {app.state === 'crashed' && app.crash ? (
              <span className="truncate font-mono text-[11px] text-red-400" title={app.crash.error}>
                {app.crash.experienceSlug} crashed: {app.crash.error}
              </span>
            ) : null}
          </span>
        </button>

        {manifest.settings ? (
          <Button onClick={() => setSettingsOpen(true)} title="App settings">
            Settings
          </Button>
        ) : null}

        {hasCalibration ? (
          <CalibrationButton
            status={calibrationStatus}
            required={requiresCalibration}
            busy={calibrating}
            onClick={() => void run(calibrate)}
          />
        ) : null}

        {defaultExperience ? (
          <Button
            variant={anyRunning ? 'stop' : 'start'}
            className="px-4 font-medium"
            title={anyRunning ? 'Stop' : `Start ${defaultExperience.name}`}
            onClick={() =>
              void (anyRunning
                ? stop(running.map((r) => r.experienceSlug))
                : start(defaultExperience.slug))
            }
          >
            {anyRunning ? (running.length > 1 ? 'Stop all' : 'Stop') : 'Start'}
          </Button>
        ) : (
          <span className="shrink-0 rounded border border-neutral-800 bg-neutral-950/50 px-3 py-1.5 text-xs text-neutral-500">
            no experiences
          </span>
        )}
      </div>

      {expanded ? (
        <div className="space-y-4 border-t border-neutral-800 bg-neutral-950/40 px-4 py-3 pl-9">
          {manifest.description ? (
            <p className="text-xs text-neutral-400">{manifest.description}</p>
          ) : null}

          {experiences.length > 1 ? (
            <div className="space-y-1.5">
              <p className="font-mono text-[10px] tracking-wider text-neutral-500 uppercase">
                experiences
              </p>
              {experiences.map((experience) => {
                const isRunning = running.some((r) => r.experienceSlug === experience.slug);
                return (
                  <div
                    key={experience.slug}
                    className="flex items-center justify-between gap-3 rounded border border-neutral-800 bg-neutral-900/60 px-3 py-1.5"
                  >
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-[12px] text-neutral-100">
                        {experience.name}
                      </span>
                      <span className="truncate font-mono text-[10px] text-neutral-500">
                        {experience.slug}
                        {experience.slug === defaultExperience?.slug ? ' · default' : ''}
                      </span>
                    </span>
                    <Button
                      size="sm"
                      variant={isRunning ? 'stop' : 'start'}
                      onClick={() =>
                        void (isRunning ? stop([experience.slug]) : start(experience.slug))
                      }
                    >
                      {isRunning ? 'stop' : 'start'}
                    </Button>
                  </div>
                );
              })}
            </div>
          ) : null}

          {hasRequirements ? (
            <DeviceSettingsSection
              appSlug={appSlug}
              requirements={requirements}
              devices={devices}
              devicesLoading={devicesLoading}
              onRescanDevices={onRescanDevices}
            />
          ) : null}

          <div className="flex justify-end gap-4">
            {hasPermissionRequests(app) ? (
              <Button variant="link" onClick={() => onReviewPermissions(app)}>
                permissions
              </Button>
            ) : null}
            {app.builtin ? null : (
              <Button variant="danger-link" onClick={() => onUninstall(app)}>
                uninstall
              </Button>
            )}
          </div>
        </div>
      ) : null}

      {manifest.settings ? (
        <AppSettingsDialog
          app={app}
          schema={manifest.settings}
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}
    </li>
  );
}

function CalibrationButton({
  status,
  required,
  busy,
  onClick,
}: {
  readonly status: CalibrationStatus;
  readonly required: boolean;
  readonly busy: boolean;
  onClick(): void;
}): React.ReactElement {
  if (status === 'calibrated') {
    return (
      <Button size="sm" onClick={onClick} disabled={busy} title="Recalibrate this app">
        {busy ? 'calibrating…' : '✓ calibrated'}
      </Button>
    );
  }
  // An app that requires calibration and has none gets a prominent button.
  const urgent = required && status === 'uncalibrated';
  return (
    <Button
      variant={urgent ? 'warning' : 'default'}
      className="flex items-center gap-1.5 font-medium"
      onClick={onClick}
      disabled={busy}
      title="Calibrate this app"
    >
      {urgent ? <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" /> : null}
      {busy ? 'Calibrating…' : 'Calibrate'}
    </Button>
  );
}
