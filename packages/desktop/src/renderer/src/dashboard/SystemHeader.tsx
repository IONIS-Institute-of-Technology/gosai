import { useCallback, useEffect, useState } from 'react';
import { CALIBRATION_SLUG, runCalibrationWizard } from '../lib/calibration-wizard.js';
import { isNotConnectedError } from '../lib/server-client.js';
import { useServer } from '../lib/server-context.js';

const SERVER_BASE_URL = 'http://127.0.0.1:7777';

type CalibrationStatus = 'unknown' | 'calibrated' | 'required';

export function SystemHeader(): React.ReactElement {
  const { client, status } = useServer();
  const [calibration, setCalibration] = useState<CalibrationStatus>('unknown');
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const probe = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch(
        `${SERVER_BASE_URL}/v1/apps/${CALIBRATION_SLUG}/storage/homography`,
      );
      if (res.status === 200) {
        setCalibration('calibrated');
      } else if (res.status === 404) {
        setCalibration('required');
      } else {
        setCalibration('unknown');
      }
    } catch {
      // Server unreachable; the status bar already surfaces that.
      setCalibration('unknown');
    }
  }, []);

  useEffect(() => {
    if (status !== 'connected') return;
    void probe();
  }, [status, probe]);

  useEffect(() => {
    const offFinished = client.on(`app:${CALIBRATION_SLUG}:wizard:finished`, () => {
      void probe();
    });
    const offApps = client.on('apps:list-changed', () => {
      void probe();
    });
    return () => {
      offFinished();
      offApps();
    };
  }, [client, probe]);

  const handleCalibrate = async (): Promise<void> => {
    if (status !== 'connected' || starting) return;
    setStarting(true);
    setError(null);
    try {
      await runCalibrationWizard(client);
      await probe();
    } catch (err) {
      if (!isNotConnectedError(err)) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setStarting(false);
    }
  };

  return (
    <header className="flex items-center justify-between border-b border-neutral-800 bg-neutral-900/40 px-5 py-3">
      <div className="flex items-baseline gap-3">
        <h1 className="font-mono text-sm font-medium tracking-tight text-neutral-100">GOSAI</h1>
        <span className="font-mono text-xs text-neutral-500">v{window.gosai?.version}</span>
      </div>
      <div className="flex items-center gap-3">
        {calibration === 'required' ? (
          <span
            className="flex items-center gap-1.5 rounded border border-amber-900/50 bg-amber-950/40 px-2 py-1 font-mono text-[11px] uppercase tracking-wider text-amber-200"
            title="No homography data found. Use Calibrate to set it up."
          >
            <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
            calibration required
          </span>
        ) : null}
        {error ? (
          <span className="max-w-[200px] truncate font-mono text-[11px] text-red-400" title={error}>
            {error}
          </span>
        ) : null}
        <button
          type="button"
          onClick={() => void handleCalibrate()}
          disabled={status !== 'connected' || starting}
          className="rounded border border-amber-900/50 bg-amber-950/40 px-4 py-1.5 text-sm font-medium text-amber-200 transition-colors hover:bg-amber-900/40 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {starting ? 'Calibrating…' : 'Calibrate'}
        </button>
      </div>
    </header>
  );
}
