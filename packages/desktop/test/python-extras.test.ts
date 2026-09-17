import { describe, expect, test } from 'bun:test';
import {
  nvidiaDriverMajor,
  pythonExtras,
  uvSyncArgs,
  type PythonHost,
} from '../src/main/python-extras.js';

const proprietary =
  'NVRM version: NVIDIA UNIX x86_64 Kernel Module  580.65.06  Sun Jul 27 06:54:38 UTC 2025\n' +
  'GCC version:  gcc version 12.2.0 (Debian 12.2.0-14)\n';
const open =
  'NVRM version: NVIDIA UNIX Open Kernel Module for x86_64  590.44.01  Release Build  (dvs-builder@U16-I3-B03-4-3)\n';
const old =
  'NVRM version: NVIDIA UNIX x86_64 Kernel Module  550.54.14  Thu Feb 22 01:44:30 UTC 2024\n';

const linux = (nvidiaDriverVersionFile: string | null): PythonHost => ({
  platform: 'linux',
  arch: 'x64',
  nvidiaDriverVersionFile,
});

describe('nvidiaDriverMajor', () => {
  test('reads proprietary and open kernel module versions', () => {
    expect(nvidiaDriverMajor(proprietary)).toBe(580);
    expect(nvidiaDriverMajor(open)).toBe(590);
    expect(nvidiaDriverMajor('garbage')).toBeNull();
  });
});

describe('pythonExtras', () => {
  test('adds gpu on Linux x64 with driver 580 or newer', () => {
    const result = pythonExtras(['speech', 'speech'], linux(proprietary));
    expect(result.extras).toEqual(['gpu', 'speech']);
    expect(result.gpuReason).toContain('driver 580');
  });

  test('keeps the CPU build and says why otherwise', () => {
    expect(pythonExtras([], linux(null))).toEqual({
      extras: [],
      gpuReason: 'no NVIDIA driver loaded; using CPU onnxruntime',
    });
    const tooOld = pythonExtras([], linux(old));
    expect(tooOld.extras).toEqual([]);
    expect(tooOld.gpuReason).toContain('550 is older than 580');
    expect(pythonExtras([], linux('garbage')).gpuReason).toContain('could not read');
  });

  test('never adds gpu off Linux x64 and drops it on macOS', () => {
    expect(pythonExtras([], { ...linux(proprietary), arch: 'arm64' }).extras).toEqual([]);
    const mac: PythonHost = { platform: 'darwin', arch: 'arm64', nvidiaDriverVersionFile: null };
    expect(pythonExtras(['gpu'], mac)).toEqual({ extras: [], gpuReason: null });
  });
});

describe('uvSyncArgs', () => {
  const base = ['sync', '--frozen', '--no-dev', '--python', '3.12'];

  test('syncs once without gpu', () => {
    expect(uvSyncArgs(['speech'], '3.12')).toEqual([[...base, '--extra', 'speech']]);
  });

  test('swaps the cpu group for gpu', () => {
    expect(uvSyncArgs(['gpu'], '3.12')).toEqual([[...base, '--extra', 'gpu', '--no-group', 'cpu']]);
  });

  test('reinstalls onnxruntime-gpu last when speech pulls in the CPU wheel', () => {
    const sync = [...base, '--extra', 'gpu', '--extra', 'speech', '--no-group', 'cpu'];
    expect(uvSyncArgs(['gpu', 'speech'], '3.12')).toEqual([
      sync,
      [...sync, '--reinstall-package', 'onnxruntime-gpu'],
    ]);
  });
});
