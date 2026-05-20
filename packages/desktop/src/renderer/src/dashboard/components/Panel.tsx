import type { ReactNode } from 'react';

interface PanelProps {
  title: string;
  children: ReactNode;
  compact?: boolean;
}

export function Panel({ title, children, compact }: PanelProps): React.ReactElement {
  return (
    <section className="rounded border border-neutral-800 bg-neutral-900/40">
      <header className="border-b border-neutral-800 px-4 py-2.5">
        <h2 className="font-mono text-[11px] uppercase tracking-wider text-neutral-400">{title}</h2>
      </header>
      <div className={compact ? 'p-3' : 'p-4'}>{children}</div>
    </section>
  );
}
