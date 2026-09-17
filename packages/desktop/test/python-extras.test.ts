import { describe, expect, test } from 'bun:test';
import { pythonExtras, uvSyncArgs, type PythonHost } from '../src/main/python-extras.js';

const linuxNvidia: PythonHost = { platform: 'linux', arch: 'x64', hasNvidiaGpu: true };

describe('pythonExtras', () => {
  test('adds gpu on Linux x64 with an NVIDIA GPU', () => {
    expect(pythonExtras(['speech', 'speech'], linuxNvidia)).toEqual(['gpu', 'speech']);
  });

  test('keeps the CPU build elsewhere', () => {
    expect(pythonExtras(['speech'], { ...linuxNvidia, hasNvidiaGpu: false })).toEqual(['speech']);
    expect(pythonExtras([], { ...linuxNvidia, arch: 'arm64' })).toEqual([]);
    expect(
      pythonExtras(['gpu'], { platform: 'darwin', arch: 'arm64', hasNvidiaGpu: false }),
    ).toEqual([]);
  });
});

describe('uvSyncArgs', () => {
  test('syncs once without gpu', () => {
    expect(uvSyncArgs(['speech'], '3.12')).toEqual([
      ['sync', '--frozen', '--no-dev', '--python', '3.12', '--extra', 'speech'],
    ]);
  });

  test('swaps the cpu group for gpu and reinstalls onnxruntime-gpu last', () => {
    const base = ['sync', '--frozen', '--no-dev', '--python', '3.12', '--extra', 'gpu'];
    expect(uvSyncArgs(['gpu'], '3.12')).toEqual([
      [...base, '--no-group', 'cpu'],
      [...base, '--no-group', 'cpu', '--reinstall-package', 'onnxruntime-gpu'],
    ]);
  });
});
