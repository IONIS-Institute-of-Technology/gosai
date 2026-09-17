import { useState } from 'react';
import { Button } from '../../components/Button.js';
import { Dialog } from '../../components/Dialog.js';
import { ErrorText } from '../../components/ErrorText.js';

export interface UninstallRequest {
  readonly slug: string;
  readonly name: string;
}

interface UninstallDialogProps {
  readonly request: UninstallRequest | null;
  readonly busy: boolean;
  readonly error: string | null;
  onConfirm(slug: string, deleteData: boolean): void;
  onClose(): void;
}

export function UninstallDialog({
  request,
  busy,
  error,
  onConfirm,
  onClose,
}: UninstallDialogProps): React.ReactElement {
  const [deleteData, setDeleteData] = useState(false);
  const close = (): void => {
    setDeleteData(false);
    onClose();
  };
  return (
    <Dialog
      open={request !== null}
      onClose={close}
      title={`Uninstall ${request?.name ?? ''}?`}
      subtitle={request?.slug}
      footer={
        <>
          <Button size="sm" onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant="stop"
            disabled={busy}
            onClick={() => request && onConfirm(request.slug, deleteData)}
          >
            {busy ? 'Uninstalling…' : 'Uninstall'}
          </Button>
        </>
      }
    >
      <p className="text-xs text-neutral-400">
        The app&apos;s files are removed. Its storage, settings and calibration are kept for a later
        install from the same source, unless you delete them now.
      </p>
      <label className="flex items-center gap-2 text-sm text-neutral-200">
        <input
          type="checkbox"
          className="h-4 w-4 accent-red-500"
          checked={deleteData}
          disabled={busy}
          onChange={(e) => setDeleteData(e.target.checked)}
        />
        Also delete its data
      </label>
      <ErrorText error={error} />
    </Dialog>
  );
}
