import { useEffect, useRef, type ReactNode } from 'react';

interface DialogProps {
  readonly open: boolean;
  /** Called when the user presses Escape, clicks the backdrop or a close button. */
  readonly onClose: () => void;
  readonly title: ReactNode;
  readonly subtitle?: ReactNode;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
  readonly width?: 'md' | 'lg';
}

/**
 * A modal on the native `<dialog>` element, which traps focus, closes on
 * Escape and restores focus when it closes. The content only renders while
 * the dialog is open.
 */
export function Dialog({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  width = 'md',
}: DialogProps): React.ReactElement {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      // Escape fires `cancel`; let the parent decide by closing through `open`.
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
      className={`m-auto max-h-[85vh] w-full ${width === 'lg' ? 'max-w-2xl' : 'max-w-lg'} rounded-lg border border-neutral-700 bg-neutral-900 p-0 text-neutral-100 shadow-2xl backdrop:bg-black/60`}
    >
      {open ? (
        <div className="flex max-h-[85vh] flex-col">
          <header className="flex items-center justify-between gap-3 border-b border-neutral-800 px-5 py-3">
            <div className="flex min-w-0 flex-col">
              <h2 className="truncate text-sm font-medium text-neutral-100">{title}</h2>
              {subtitle ? (
                <span className="truncate font-mono text-[11px] text-neutral-500">{subtitle}</span>
              ) : null}
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
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">{children}</div>
          {footer ? (
            <footer className="flex items-center justify-end gap-2 border-t border-neutral-800 px-5 py-3">
              {footer}
            </footer>
          ) : null}
        </div>
      ) : null}
    </dialog>
  );
}
