export function ErrorText({
  error,
}: {
  error: string | null | undefined;
}): React.ReactElement | null {
  if (!error) return null;
  return <p className="font-mono text-xs break-words text-red-400">{error}</p>;
}
