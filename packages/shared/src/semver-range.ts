/**
 * Syntax check for npm-style semver ranges such as `^0.1.0`, `>=0.2 <1` or
 * `0.1.x || 0.2.x`. The server compares versions with `Bun.semver`; this only
 * rejects strings that aren't ranges at all, which `Bun.semver` would treat
 * as matching everything.
 */

const PART = '(?:0|[1-9]\\d*|[xX*])';
const IDENTIFIERS = '[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*';
const VERSION = `v?${PART}(?:\\.${PART}(?:\\.${PART}(?:-${IDENTIFIERS})?(?:\\+${IDENTIFIERS})?)?)?`;
const COMPARATOR = `(?:\\*|(?:\\^|~>?|[<>]=?|=)?\\s*${VERSION})`;
const RANGE = `(?:${VERSION}\\s+-\\s+${VERSION}|${COMPARATOR}(?:\\s+${COMPARATOR})*)`;
const RANGE_SET = new RegExp(`^\\s*${RANGE}(?:\\s*\\|\\|\\s*${RANGE})*\\s*$`);

export function isSemverRange(value: string): boolean {
  return value.length <= 256 && RANGE_SET.test(value);
}
