#!/usr/bin/env bun
/**
 * Prepares the per-target resources electron-builder packs:
 *
 *   packages/desktop/release/bundle/<target>/server/gosai-server[.exe]
 *   packages/desktop/release/bundle/<target>/bin/uv[.exe]
 *   packages/desktop/release/bundle/python-runtime.json
 *
 * The server is cross-compiled with `bun build --compile --target`, uv is
 * the pinned and checksummed release, and python-runtime.json holds the hash
 * of the Python tree and the Python version from pyproject.toml, so the
 * packaged app doesn't hash the tree at every launch.
 *
 * Usage:
 *   bun scripts/prepare-bundle.ts [--target linux-x64|mac-arm64|win-x64]
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pythonRuntimeInfo } from '../packages/desktop/src/main/python-runtime.js';
import { fetchUv } from './fetch-uv.js';
import { hostTarget, parseTarget, TARGETS, type TargetName } from './targets.js';

const repoRoot = resolve(import.meta.dir, '..');
export const bundleRoot = join(repoRoot, 'packages', 'desktop', 'release', 'bundle');

export async function prepareBundle(target: TargetName): Promise<void> {
  const { bun, exe } = TARGETS[target];
  const targetDir = join(bundleRoot, target);
  rmSync(targetDir, { recursive: true, force: true });
  mkdirSync(join(targetDir, 'server'), { recursive: true });

  const outfile = join(targetDir, 'server', `gosai-server${exe}`);
  const cmd = [
    process.execPath,
    'build',
    join(repoRoot, 'packages', 'server', 'src', 'index.ts'),
    '--compile',
    `--target=${bun}`,
    '--outfile',
    outfile,
  ];
  console.log(`[prepare-bundle] $ ${cmd.join(' ')}`);
  const proc = Bun.spawn({ cmd, cwd: repoRoot, stdout: 'inherit', stderr: 'inherit' });
  if ((await proc.exited) !== 0) throw new Error(`compiling the server for ${target} failed`);

  await fetchUv(target, join(targetDir, 'bin'));

  const info = pythonRuntimeInfo(join(repoRoot, 'python'));
  writeFileSync(join(bundleRoot, 'python-runtime.json'), `${JSON.stringify(info, null, 2)}\n`);
  console.log(`[prepare-bundle] Python ${info.python}, tree ${info.treeHash.slice(0, 12)}`);
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { target: { type: 'string' } } });
  try {
    await prepareBundle(values.target ? parseTarget(values.target) : hostTarget());
  } catch (err) {
    console.error(`[prepare-bundle] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
