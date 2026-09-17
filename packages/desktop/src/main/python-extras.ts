import { existsSync } from 'node:fs';

/** The NVIDIA kernel driver creates this file once it has loaded. */
const NVIDIA_DRIVER_VERSION_FILE = '/proc/driver/nvidia/version';

export interface PythonHost {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly hasNvidiaGpu: boolean;
}

export function currentPythonHost(): PythonHost {
  return {
    platform: process.platform,
    arch: process.arch,
    hasNvidiaGpu: process.platform === 'linux' && existsSync(NVIDIA_DRIVER_VERSION_FILE),
  };
}

/**
 * The requested extras, plus `gpu` on Linux x64 with an NVIDIA GPU. `gpu`
 * replaces the CPU onnxruntime, and there is no NVIDIA build for macOS, so it
 * is dropped there.
 */
export function pythonExtras(requested: readonly string[], host: PythonHost): string[] {
  const extras = new Set(requested);
  if (host.platform === 'linux' && host.arch === 'x64' && host.hasNvidiaGpu) extras.add('gpu');
  if (host.platform === 'darwin') extras.delete('gpu');
  return [...extras].sort();
}

/**
 * The `uv sync` argument lists to run in order.
 *
 * The `gpu` extra swaps the default `cpu` group for onnxruntime-gpu. faster-whisper
 * (the `speech` extra) still depends on the CPU onnxruntime, which installs over
 * the same files in an unpredictable order, so onnxruntime-gpu is reinstalled
 * after the first sync.
 */
export function uvSyncArgs(extras: readonly string[], python: string): string[][] {
  const sync = [
    'sync',
    '--frozen',
    '--no-dev',
    '--python',
    python,
    ...extras.flatMap((extra) => ['--extra', extra]),
  ];
  if (!extras.includes('gpu')) return [sync];
  sync.push('--no-group', 'cpu');
  return [sync, [...sync, '--reinstall-package', 'onnxruntime-gpu']];
}
