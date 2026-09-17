/**
 * Packs `@gosai/sdk` for npm:
 *
 *   bun run pack:npm --destination <dir>
 *
 * Builds the SDK, copies what the package ships into a staging directory with
 * a package.json stripped of what only this repository uses (the
 * `@gosai/source` export condition, scripts and devDependencies), and runs
 * `bun pm pack` there. Prints the tarball's path last.
 */

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const SOURCE_CONDITION = '@gosai/source';

type ExportsValue = string | { readonly [condition: string]: ExportsValue };

/** The package.json that ships: no source condition, scripts or devDependencies. */
export function publishedManifest(manifest: Record<string, unknown>): Record<string, unknown> {
  const { scripts: _scripts, devDependencies: _devDependencies, ...rest } = manifest;
  return rest.exports === undefined
    ? rest
    : { ...rest, exports: withoutSourceCondition(rest.exports as ExportsValue) };
}

function withoutSourceCondition(value: ExportsValue): ExportsValue {
  if (typeof value === 'string') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([condition]) => condition !== SOURCE_CONDITION)
      .map(([condition, target]) => [condition, withoutSourceCondition(target)]),
  );
}

async function run(cmd: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn({ cmd, cwd, stdout: 'inherit', stderr: 'inherit' });
  if ((await proc.exited) !== 0) throw new Error(`${cmd.join(' ')} failed`);
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { destination: { type: 'string' } } });
  const packageDir = resolve(import.meta.dir, '..');
  const destination = resolve(values.destination ?? packageDir);

  await run([process.execPath, 'run', 'build'], packageDir);
  const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  const stage = mkdtempSync(join(tmpdir(), 'gosai-sdk-pack-'));
  try {
    for (const file of manifest.files as string[]) {
      cpSync(join(packageDir, file), join(stage, file), { recursive: true });
    }
    cpSync(join(packageDir, 'README.md'), join(stage, 'README.md'));
    writeFileSync(
      join(stage, 'package.json'),
      `${JSON.stringify(publishedManifest(manifest), null, 2)}\n`,
    );
    await run([process.execPath, 'pm', 'pack', '--destination', destination], stage);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
  console.log(join(destination, `gosai-sdk-${String(manifest.version)}.tgz`));
}
