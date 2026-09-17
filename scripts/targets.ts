/**
 * Packaging targets. Names match electron-builder's `${os}-${arch}` macros,
 * which pick the per-target resources in packages/desktop/release/bundle/.
 * Linux x64 and macOS arm64 are supported; Windows x64 is best effort.
 */

export interface Target {
  /** `bun build --compile --target` value. */
  readonly bun: string;
  /** Rust target triple of the uv release asset. */
  readonly uvTriple: string;
  readonly uvArchive: 'tar.gz' | 'zip';
  /** Executable suffix. */
  readonly exe: '' | '.exe';
  /** electron-builder platform flag. */
  readonly builderFlag: '--linux' | '--mac' | '--win';
}

export const TARGETS = {
  'linux-x64': {
    bun: 'bun-linux-x64',
    uvTriple: 'x86_64-unknown-linux-gnu',
    uvArchive: 'tar.gz',
    exe: '',
    builderFlag: '--linux',
  },
  'mac-arm64': {
    bun: 'bun-darwin-arm64',
    uvTriple: 'aarch64-apple-darwin',
    uvArchive: 'tar.gz',
    exe: '',
    builderFlag: '--mac',
  },
  'win-x64': {
    bun: 'bun-windows-x64',
    uvTriple: 'x86_64-pc-windows-msvc',
    uvArchive: 'zip',
    exe: '.exe',
    builderFlag: '--win',
  },
} as const satisfies Record<string, Target>;

export type TargetName = keyof typeof TARGETS;

export function isTargetName(value: string): value is TargetName {
  return Object.hasOwn(TARGETS, value);
}

export function parseTarget(value: string): TargetName {
  if (!isTargetName(value)) {
    throw new Error(`unknown target "${value}"; use ${Object.keys(TARGETS).join(', ')}`);
  }
  return value;
}

/** The target matching this machine. */
export function hostTarget(): TargetName {
  const os = { linux: 'linux', darwin: 'mac', win32: 'win' }[process.platform as string];
  const name = `${os}-${process.arch}`;
  if (!isTargetName(name)) {
    throw new Error(`${process.platform} ${process.arch} is not a packaging target; pass --target`);
  }
  return name;
}
