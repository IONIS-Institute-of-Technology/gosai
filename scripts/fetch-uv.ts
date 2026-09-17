#!/usr/bin/env bun
/**
 * Downloads the pinned `uv` release for a packaging target, checks it against
 * the sha256 published with that release, and copies the binary to `outDir`.
 * Packaged bundles ship it as resources/bin/uv so the first launch can build
 * the Python environment on a machine without uv.
 *
 * Usage:
 *   bun scripts/fetch-uv.ts [--target linux-x64|mac-arm64|win-x64] [--out <dir>]
 *
 * Verified archives are cached per version under
 * packages/desktop/release/cache/. GOSAI_UV_VERSION picks another version,
 * checked against the .sha256 file of its release instead of the pins below.
 */

import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { hostTarget, parseTarget, TARGETS, type TargetName } from './targets.js';

export const UV_VERSION = '0.12.15';

/** From the `uv-<triple>.<ext>.sha256` assets of the UV_VERSION release. */
const UV_SHA256: Record<TargetName, string> = {
  'linux-x64': 'f97935763c04be3e692460a7aaeaaab8fc3b78fcf8b389da820b38ae7423a638',
  'mac-arm64': 'dc304b9ed1b24174572290fba60ac3f6fe63c73a671f0439e62a91375841964d',
  'win-x64': '477bd99a84e34891f2bd4c9152ddeb74e971accccbc59c0f0301f11f08a32d46',
};

const repoRoot = resolve(import.meta.dir, '..');
const cacheRoot = join(repoRoot, 'packages', 'desktop', 'release', 'cache');

/** Writes `uv` (or `uv.exe`) for `target` into `outDir` and returns its path. */
export async function fetchUv(target: TargetName, outDir: string): Promise<string> {
  const { uvTriple, uvArchive, exe } = TARGETS[target];
  const version = process.env.GOSAI_UV_VERSION || UV_VERSION;
  const asset = `uv-${uvTriple}.${uvArchive}`;
  const url = `https://github.com/astral-sh/uv/releases/download/${version}/${asset}`;
  const expected = version === UV_VERSION ? UV_SHA256[target] : await publishedSha256(url);

  const archive = join(cacheRoot, `uv-${version}`, asset);
  if (!existsSync(archive) || sha256(await Bun.file(archive).bytes()) !== expected) {
    console.log(`[fetch-uv] downloading ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`download failed (${res.status}) for ${url}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const actual = sha256(bytes);
    if (actual !== expected) {
      throw new Error(`sha256 mismatch for ${asset}: expected ${expected}, got ${actual}`);
    }
    mkdirSync(join(archive, '..'), { recursive: true });
    await Bun.write(archive, bytes);
  }

  const workDir = join(tmpdir(), `gosai-uv-${uvTriple}-${process.pid}`);
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });
  try {
    await extract(archive, workDir);
    const binary = findFile(workDir, `uv${exe}`);
    if (!binary) throw new Error(`uv${exe} not found in ${asset}`);
    mkdirSync(outDir, { recursive: true });
    const outPath = join(outDir, `uv${exe}`);
    cpSync(binary, outPath);
    chmodSync(outPath, 0o755);
    console.log(`[fetch-uv] uv ${version} (${target}) -> ${outPath}`);
    return outPath;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function publishedSha256(url: string): Promise<string> {
  const res = await fetch(`${url}.sha256`);
  if (!res.ok) throw new Error(`no published sha256 (${res.status}) at ${url}.sha256`);
  const hash = (await res.text()).trim().split(/\s+/)[0] ?? '';
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error(`unreadable sha256 at ${url}.sha256`);
  return hash;
}

async function extract(archive: string, into: string): Promise<void> {
  // GNU tar on Linux can't read zip files; bsdtar on macOS and Windows can.
  const cmd =
    archive.endsWith('.zip') && process.platform === 'linux'
      ? ['unzip', '-q', '-o', archive, '-d', into]
      : ['tar', '-xf', archive, '-C', into];
  const proc = Bun.spawn({ cmd, stdout: 'inherit', stderr: 'inherit' });
  if ((await proc.exited) !== 0) throw new Error(`${cmd.join(' ')} failed`);
}

function findFile(directory: string, name: string): string | null {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      const found = findFile(path, name);
      if (found) return found;
    } else if (entry === name) {
      return path;
    }
  }
  return null;
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: { target: { type: 'string' }, out: { type: 'string' } },
  });
  const target = values.target ? parseTarget(values.target) : hostTarget();
  const outDir = resolve(
    values.out ?? join(repoRoot, 'packages', 'desktop', 'release', 'bundle', target, 'bin'),
  );
  try {
    await fetchUv(target, outDir);
  } catch (err) {
    console.error(`[fetch-uv] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
