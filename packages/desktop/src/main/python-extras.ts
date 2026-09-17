import { existsSync, readFileSync } from 'node:fs';

/** The NVIDIA kernel driver creates this file once it has loaded. */
const NVIDIA_DRIVER_VERSION_FILE = '/proc/driver/nvidia/version';

/** onnxruntime-gpu 1.30 uses CUDA 13, which needs driver 580 or newer. */
export const MIN_NVIDIA_DRIVER = 580;

export interface PythonHost {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  /** Contents of /proc/driver/nvidia/version, or null when no driver is loaded. */
  readonly nvidiaDriverVersionFile: string | null;
}

export interface PythonExtras {
  readonly extras: string[];
  /** Why `gpu` was or wasn't added, for the log. Null when the question doesn't apply. */
  readonly gpuReason: string | null;
}

export function currentPythonHost(): PythonHost {
  const hasDriver = process.platform === 'linux' && existsSync(NVIDIA_DRIVER_VERSION_FILE);
  return {
    platform: process.platform,
    arch: process.arch,
    nvidiaDriverVersionFile: hasDriver ? readFileSync(NVIDIA_DRIVER_VERSION_FILE, 'utf8') : null,
  };
}

/** Major version from a line like `NVRM version: NVIDIA UNIX x86_64 Kernel Module  580.65.06  ...`. */
export function nvidiaDriverMajor(versionFile: string): number | null {
  const match = /^NVRM version:.*?\s(\d+)\.\d+/m.exec(versionFile);
  return match ? Number(match[1]) : null;
}

/**
 * The requested extras, plus `gpu` on Linux x64 with an NVIDIA driver new
 * enough for CUDA 13. `gpu` replaces the CPU onnxruntime, and there is no
 * NVIDIA build for macOS, so it is dropped there.
 */
export function pythonExtras(requested: readonly string[], host: PythonHost): PythonExtras {
  const extras = new Set(requested);
  let gpuReason: string | null = null;
  if (host.platform === 'darwin') {
    extras.delete('gpu');
  } else if (host.platform === 'linux' && host.arch === 'x64') {
    const decision = gpuDecision(host.nvidiaDriverVersionFile);
    if (decision.gpu) extras.add('gpu');
    gpuReason = decision.reason;
  }
  return { extras: [...extras].sort(), gpuReason };
}

function gpuDecision(versionFile: string | null): { gpu: boolean; reason: string } {
  if (versionFile === null) {
    return { gpu: false, reason: 'no NVIDIA driver loaded; using CPU onnxruntime' };
  }
  const major = nvidiaDriverMajor(versionFile);
  if (major === null) {
    return {
      gpu: false,
      reason: 'could not read the NVIDIA driver version; using CPU onnxruntime',
    };
  }
  if (major < MIN_NVIDIA_DRIVER) {
    return {
      gpu: false,
      reason: `NVIDIA driver ${major} is older than ${MIN_NVIDIA_DRIVER} (CUDA 13); using CPU onnxruntime`,
    };
  }
  return { gpu: true, reason: `installing the gpu extra for NVIDIA driver ${major}` };
}

/**
 * The `uv sync` argument lists to run in order.
 *
 * The `gpu` extra swaps the default `cpu` group for onnxruntime-gpu. faster-whisper
 * (the `speech` extra) still depends on the CPU onnxruntime, which installs over
 * the same files in an unpredictable order, so onnxruntime-gpu is reinstalled
 * after the first sync when both are present.
 */
export function uvSyncArgs(extras: readonly string[], python: string): string[][] {
  const sync = [
    'sync',
    '--frozen',
    '--no-dev',
    // A copy of the project, not a link to the source tree, so the runtime
    // directory can be renamed after the install.
    '--no-editable',
    '--python',
    python,
    ...extras.flatMap((extra) => ['--extra', extra]),
  ];
  if (!extras.includes('gpu')) return [sync];
  sync.push('--no-group', 'cpu');
  if (!extras.includes('speech')) return [sync];
  return [sync, [...sync, '--reinstall-package', 'onnxruntime-gpu']];
}
