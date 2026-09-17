import { isNotConnectedError } from '@gosai/shared/client';

/** A message to show for anything thrown. */
export function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The message to show for a failed server request, or `null` when the
 * connection is down: the status bar already says so, and data reloads once
 * it is back.
 */
export function requestErrorMessage(err: unknown): string | null {
  return isNotConnectedError(err) ? null : toErrorMessage(err);
}
