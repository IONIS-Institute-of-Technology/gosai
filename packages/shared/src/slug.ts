/**
 * App slugs name directories on disk and driver bindings on the server, so
 * every boundary that receives one checks it against this pattern.
 */

export const SLUG_PATTERN = /^[a-z][a-z0-9-]*$/;

/** Apps run on `<slug>.localhost`, and a DNS label holds at most 63 characters. */
const MAX_SLUG_LENGTH = 63;

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
