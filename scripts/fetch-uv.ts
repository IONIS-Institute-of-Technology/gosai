#!/usr/bin/env bun
/**
 * Downloads the `uv` binary (astral.sh) for a target platform so packaged
 * GOSAI bundles can materialise the Python virtual environment on first
 * launch without anything installed on the target machine.
 *
 * Usage:
 *   bun scripts/fetch-uv.ts <mac|linux> [outDir]
 *
 * Output layout (consumed as `Resources/bin/` by electron-builder):
 *   linux: <outDir>/uv
 *   mac:   <outDir>/uv-arm64, <outDir>/uv-x64
 *
 * Pin a version with GOSAI_UV_VERSION (default: latest release).
 */

import { chmodSync, cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const TARGETS: Record<string, Array<{ triple: string; outName: string }>> = {
  linux: [{ triple: 'x86_64-unknown-linux-gnu', outName: 'uv' }],
  mac: [
    { triple: 'aarch64-apple-darwin', outName: 'uv-arm64' },
    { triple: 'x86_64-apple-darwin', outName: 'uv-x64' },
  ],
};

function fail(message: string): never {
  console.error(`[fetch-uv] ${message}`);
  process.exit(1);
}

export async function fetchUv(platform: 'mac' | 'linux', outDir: string): Promise<void> {
  const targets = TARGETS[platform];
  if (!targets) fail(`unsupported platform: ${platform}`);
  mkdirSync(outDir, { recursive: true });

  const version = process.env.GOSAI_UV_VERSION;
  for (const { triple, outName } of targets) {
    const outPath = join(outDir, outName);
    if (existsSync(outPath)) {
      console.log(`[fetch-uv] ${outName} already present, skipping download`);
      continue;
    }
    const url = version
      ? `https://github.com/astral-sh/uv/releases/download/${version}/uv-${triple}.tar.gz`
      : `https://github.com/astral-sh/uv/releases/latest/download/uv-${triple}.tar.gz`;

    console.log(`[fetch-uv] downloading ${url}`);
    const res = await fetch(url);
    if (!res.ok) fail(`download failed (${res.status}) for ${url}`);

    const workDir = join(tmpdir(), `gosai-uv-${triple}-${Date.now()}`);
    mkdirSync(workDir, { recursive: true });
    try {
      const archive = join(workDir, 'uv.tar.gz');
      await Bun.write(archive, await res.arrayBuffer());
      const tar = Bun.spawn({
        cmd: ['tar', '-xzf', archive, '-C', workDir],
        stdout: 'inherit',
        stderr: 'inherit',
      });
      if ((await tar.exited) !== 0) fail(`tar extraction failed for ${archive}`);

      const extracted = join(workDir, `uv-${triple}`, 'uv');
      if (!existsSync(extracted)) fail(`uv binary not found in archive at ${extracted}`);
      cpSync(extracted, outPath);
      chmodSync(outPath, 0o755);
      console.log(`[fetch-uv] wrote ${outPath}`);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  }
}

if (import.meta.main) {
  const [platformArg, outDirArg] = process.argv.slice(2);
  if (platformArg !== 'mac' && platformArg !== 'linux') {
    fail('usage: bun scripts/fetch-uv.ts <mac|linux> [outDir]');
  }
  const outDir = resolve(
    outDirArg ?? join(import.meta.dir, '..', 'packages', 'desktop', 'release', 'uv', platformArg),
  );
  await fetchUv(platformArg, outDir);
}
