interface EmptyStateProps {
  message: string;
}

export function EmptyState({ message }: EmptyStateProps): React.ReactElement {
  return (
    <div className="rounded border border-dashed border-neutral-800 px-4 py-6 text-center font-mono text-xs text-neutral-500">
      {message}
    </div>
  );
}
