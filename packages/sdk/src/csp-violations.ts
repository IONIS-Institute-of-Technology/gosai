/**
 * Logs Content Security Policy violations through the app logger, so a
 * blocked request shows up in the dashboard instead of failing silently.
 */

import type { AppLogger } from './types.js';

/** Distinct violations logged per experience run. */
export const MAX_LOGGED_VIOLATIONS = 20;

/** The fields of a `SecurityPolicyViolationEvent` the logger reads. */
type ViolationEvent = Pick<
  SecurityPolicyViolationEvent,
  'effectiveDirective' | 'violatedDirective' | 'blockedURI' | 'sourceFile' | 'lineNumber'
>;

/**
 * Listens for `securitypolicyviolation` events on `target` until `signal`
 * aborts. Each distinct directive and blocked URL is logged once, up to
 * `limit` entries, then one last warning says the rest are dropped.
 */
export function forwardCspViolations(
  target: EventTarget,
  log: AppLogger,
  signal: AbortSignal,
  limit = MAX_LOGGED_VIOLATIONS,
): void {
  const seen = new Set<string>();
  let dropped = false;
  target.addEventListener(
    'securitypolicyviolation',
    (event) => {
      const violation = event as unknown as ViolationEvent;
      const directive = violation.effectiveDirective || violation.violatedDirective;
      const blocked = violation.blockedURI || 'inline';
      const key = `${directive} ${blocked}`;
      if (seen.has(key)) return;
      if (seen.size >= limit) {
        if (!dropped) {
          dropped = true;
          log.warn(`more Content Security Policy violations; only the first ${limit} are logged`);
        }
        return;
      }
      seen.add(key);
      log.warn(`blocked by the Content Security Policy: ${directive} ${blocked}`, {
        directive,
        blocked,
        ...(violation.sourceFile
          ? { source: `${violation.sourceFile}:${violation.lineNumber}` }
          : {}),
        ...(directive === 'connect-src'
          ? { hint: 'list the origin under network.connect in gosai.app.json' }
          : {}),
      });
    },
    { signal },
  );
}
