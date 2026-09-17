/**
 * App slugs name directories on disk and driver bindings on the server, so
 * every boundary that receives one checks it against this pattern.
 */

export const SLUG_PATTERN = /^[a-z][a-z0-9-]*$/;

const MAX_SLUG_LENGTH = 64;

export function isValidSlug(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_SLUG_LENGTH && SLUG_PATTERN.test(value);
}

/** Returns `value` when it is a valid slug, otherwise throws naming `field`. */
export function assertSlug(value: unknown, field = 'slug'): string {
  if (!isValidSlug(value)) {
    throw new Error(`${field} must match ${SLUG_PATTERN.source} (got ${JSON.stringify(value)})`);
  }
  return value;
}

/**
 * Driver binding of the dashboard's own driver instances. No app may use it as
 * its slug, or its token would reach those instances.
 */
export const SYSTEM_BINDING = 'system';

export function isReservedSlug(value: string): boolean {
  return value === SYSTEM_BINDING;
}
