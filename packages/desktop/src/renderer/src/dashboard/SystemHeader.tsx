/**
 * Dashboard header. Calibration is configured per app (see the Apps panel), so
 * this is now just branding; connection + system stats live in the status bar.
 */
export function SystemHeader(): React.ReactElement {
  return (
    <header className="flex items-center justify-between border-b border-neutral-800 bg-neutral-900/40 px-5 py-3">
      <div className="flex items-baseline gap-3">
        <h1 className="font-mono text-sm font-medium tracking-tight text-neutral-100">GOSAI</h1>
        <span className="font-mono text-xs text-neutral-500">v{window.gosai?.version}</span>
      </div>
    </header>
  );
}
