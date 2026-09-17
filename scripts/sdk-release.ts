/**
 * Prepares an `@gosai/sdk` release for the Release SDK workflow:
 *
 *   bun scripts/sdk-release.ts --tag sdk-v0.1.0 --notes release-notes.md
 *
 * Fails unless the tag names the version in `packages/sdk/package.json` and
 * `packages/sdk/CHANGELOG.md` has a non-empty `## <version>` section. Writes
 * that section to `--notes`, and `version`, `npm-tag` and `prerelease` to
 * `$GITHUB_OUTPUT` when it is set.
 */

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const sdkDir = resolve(import.meta.dir, '..', 'packages', 'sdk');

/** The body of the `## <version>` section, or `null` when there is none. */
export function changelogSection(changelog: string, version: string): string | null {
  const lines = changelog.split('\n');
  const heading = lines.findIndex(
    (line) => /^##\s+/.test(line) && headingVersion(line) === version,
  );
  if (heading === -1) return null;
  const next = lines.findIndex((line, index) => index > heading && /^##\s+/.test(line));
  const body = lines
    .slice(heading + 1, next === -1 ? undefined : next)
    .join('\n')
    .trim();
  return body === '' ? null : body;
}

/** `## 0.2.0`, `## [0.2.0]` and `## 0.2.0 - 2026-09-17` all name 0.2.0. */
function headingVersion(line: string): string | undefined {
  return /^##\s+\[?v?([0-9][^\s\]]*)/.exec(line)?.[1];
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: { tag: { type: 'string' }, notes: { type: 'string' } },
  });
  if (!values.tag || !values.notes) {
    console.error('usage: bun scripts/sdk-release.ts --tag sdk-v<version> --notes <file>');
    process.exit(1);
  }
  const { version } = JSON.parse(readFileSync(join(sdkDir, 'package.json'), 'utf8')) as {
    version: string;
  };
  if (values.tag !== `sdk-v${version}`) {
    console.error(
      `tag ${values.tag} doesn't match @gosai/sdk ${version}; expected sdk-v${version}`,
    );
    process.exit(1);
  }
  const notes = changelogSection(readFileSync(join(sdkDir, 'CHANGELOG.md'), 'utf8'), version);
  if (!notes) {
    console.error(
      `packages/sdk/CHANGELOG.md has no entry for ${version}; add a "## ${version}" section`,
    );
    process.exit(1);
  }
  writeFileSync(values.notes, `${notes}\n`);
  const prerelease = version.includes('-');
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `version=${version}\nnpm-tag=${prerelease ? 'next' : 'latest'}\nprerelease=${prerelease}\n`,
    );
  }
  console.log(`releasing @gosai/sdk ${version}${prerelease ? ' (prerelease)' : ''}`);
}
