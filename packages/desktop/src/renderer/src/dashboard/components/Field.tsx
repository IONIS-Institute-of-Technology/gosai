import type { ReactNode } from 'react';

export const SELECT_CLASS =
  'min-w-[180px] flex-1 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 font-mono text-[11px] text-neutral-100 disabled:opacity-50';

/** A label on the left and its control on the right. */
export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}): React.ReactElement {
  return (
    <label className="flex items-center justify-between gap-3">
      <span className="w-24 shrink-0 font-mono text-[10px] tracking-wider text-neutral-500 uppercase">
        {label}
      </span>
      {children}
    </label>
  );
}
