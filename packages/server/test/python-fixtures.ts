/**
 * Fixtures for app Python drivers: a fake GOSAI Python environment with a fake
 * uv that records its calls, and helpers that write app driver packages and a
 * pure-Python wheel so real uv installs work offline.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { PythonToolchain } from '../src/apps/python-env.js';

export const REPO_PYTHON_DIR = resolve(import.meta.dir, '..', '..', '..', 'python');
export const HAS_PYTHON_ENV = existsSync(join(REPO_PYTHON_DIR, '.venv', 'bin', 'gosai-bridge'));
export const HAS_UV = Bun.which('uv') !== null;

export interface FakeToolchain {
  readonly toolchain: PythonToolchain;
  /** Arguments of every uv call, one string per call. */
  calls(): string[];
  /** Makes `uv pip install` fail with a resolver-like message. */
  failPipInstall(fail: boolean): void;
  /**
   * Makes `uv pip install` hang, with a child process of its own, until killed.
   * Their pids go to `pidFile`, one per line: uv's, then the child's.
   */
  hangPipInstall(hang: boolean): void;
  readonly pidFile: string;
  /** Adds a package to the fake base environment. */
  addBasePackage(distInfo: string): void;
}

/**
 * A base environment with numpy and gosai-py, and a uv script that creates an
 * empty venv and logs its arguments.
 */
export function fakeToolchain(root: string): FakeToolchain {
  const pythonDir = join(root, 'base-python');
  const venv = join(pythonDir, '.venv');
  const site = join(venv, 'lib', 'python3.12', 'site-packages');
  mkdirSync(join(venv, 'bin'), { recursive: true });
  mkdirSync(join(site, 'numpy-2.3.1.dist-info'), { recursive: true });
  mkdirSync(join(site, 'gosai_py-0.1.0.dist-info'), { recursive: true });
  writeFileSync(join(venv, 'bin', 'python'), '');
  writeFileSync(join(venv, 'pyvenv.cfg'), 'home = /opt/python/bin\nversion_info = 3.12.4\n');

  const log = join(root, 'uv-calls.log');
  const failFlag = join(root, 'uv-fail-pip');
  const hangFlag = join(root, 'uv-hang-pip');
  const pidFile = join(root, 'uv-pids');
  const uv = join(root, 'fake-uv');
  writeFileSync(
    uv,
    `#!/bin/sh
echo "$*" >> '${log}'
if [ "$1" = venv ]; then
  for venv; do :; done
  mkdir -p "$venv/bin" "$venv/lib/python3.12/site-packages"
  touch "$venv/bin/python"
fi
if [ "$1" = pip ] && [ -f '${hangFlag}' ]; then
  echo $$ > '${pidFile}'
  sleep 60 &
  echo $! >> '${pidFile}'
  wait
fi
if [ "$1" = pip ] && [ -f '${failFlag}' ]; then
  echo "No solution found: numpy==1.26.0 conflicts with numpy==2.3.1" >&2
  exit 1
fi
`,
  );
  chmodSync(uv, 0o755);
  return {
    toolchain: { pythonDir, uv },
    calls: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []),
    failPipInstall: (fail) => {
      if (fail) writeFileSync(failFlag, '');
      else rmSync(failFlag, { force: true });
    },
    hangPipInstall: (hang) => {
      if (hang) writeFileSync(hangFlag, '');
      else rmSync(hangFlag, { force: true });
    },
    pidFile,
    addBasePackage: (distInfo) => mkdirSync(join(site, distInfo), { recursive: true }),
  };
}

/** Whether a process runs. A zombie waiting for a parent that never reaps it counts as gone. */
export function processRuns(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, 'utf8'));
  } catch {
    return true;
  }
}

/** A tiny counter driver, plus a `crash` action that ends the bridge process. */
export const COUNTER_DRIVER = `
import os
from collections.abc import Mapping
from typing import ClassVar

import msgspec

from gosai_py import BaseDriver, Event, action


class Count(msgspec.Struct):
    count: int


class Counter(BaseDriver):
    name = "counter"
    description = "Counts for tests."
    events: ClassVar[Mapping[str, Event]] = {"count": Event(Count, "The count.")}
    loop_interval_s = 0.05

    def __init__(self, context):
        super().__init__(context)
        self.value = 0

    def loop(self):
        self.value += 1
        self.emit("count", Count(self.value))

    @action("Where the process runs, and the tiny dependency's value.")
    def where(self) -> dict:
        import tinydep

        return {"slug": os.environ.get("GOSAI_APP_SLUG"), "tinydep": tinydep.VALUE}

    @action("End the bridge process at once.")
    def crash(self) -> None:
        os._exit(3)
`;

/** Writes a driver package at `<appDir>/python/<package>` and returns the manifest's `python`. */
export function writeDriverPackage(
  appDir: string,
  modules: Readonly<Record<string, string>>,
  packageName = 'test_drivers',
): { drivers: string } {
  const dir = join(appDir, 'python', packageName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '__init__.py'), '');
  for (const [name, source] of Object.entries(modules)) writeFileSync(join(dir, name), source);
  return { drivers: `python/${packageName}` };
}

/** Builds `tinydep-0.1.0-py3-none-any.whl` in `dir` with the repository's Python. */
export function writeTinyWheel(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const script = `
import base64, hashlib, sys, zipfile
name, version = "tinydep", "0.1.0"
info = f"{name}-{version}.dist-info"
files = {
    f"{name}/__init__.py": b"VALUE = 42\\n",
    f"{info}/METADATA": f"Metadata-Version: 2.1\\nName: {name}\\nVersion: {version}\\n".encode(),
    f"{info}/WHEEL": b"Wheel-Version: 1.0\\nGenerator: gosai-test\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n",
}
record = []
for path, data in files.items():
    digest = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode()
    record.append(f"{path},sha256={digest},{len(data)}")
record.append(f"{info}/RECORD,,")
files[f"{info}/RECORD"] = ("\\n".join(record) + "\\n").encode()
with zipfile.ZipFile(sys.argv[1], "w") as wheel:
    for path, data in files.items():
        wheel.writestr(path, data)
`;
  const wheel = join(dir, 'tinydep-0.1.0-py3-none-any.whl');
  const result = Bun.spawnSync({
    cmd: [join(REPO_PYTHON_DIR, '.venv', 'bin', 'python'), '-c', script, wheel],
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return wheel;
}
