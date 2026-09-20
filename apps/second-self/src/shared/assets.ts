/**
 * Checks that the files a layer needs are really there.
 *
 * The app's media (the VRM model, the dance animation, the sign clips, the
 * sign-game art) is stored with Git LFS. A checkout made without `git lfs
 * pull` keeps ~130-byte pointer stubs in their place, and those fetch with a
 * 200 and then decode into nothing: the layer drew an empty screen and said
 * nothing about why. Layers declare what they need in `preload`, and the guide
 * overlay puts whatever is broken on the mirror where the user can read it.
 *
 * The Python side already reports this for its models (see
 * `gosai_py.runtime.models`); this is the same check on the browser side.
 */

const LFS_POINTER_PREFIX = 'version https://git-lfs.github.com/spec/v1';

export type AssetFault = 'missing' | 'lfs-pointer';

export interface AssetProblem {
  /** The path under `assets/`, as the layer asked for it. */
  readonly path: string;
  readonly fault: AssetFault;
}

/** Just enough of `fetch` for a probe, so tests don't need a server. */
export type FetchLike = (url: string) => Promise<Response>;

/**
 * Reads the first `length` bytes of a response as text and drops the rest, so
 * probing a 16 MB model doesn't download it.
 */
async function readHead(res: Response, length: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return (await res.text()).slice(0, length);
  const bytes = new Uint8Array(length);
  let filled = 0;
  try {
    while (filled < length) {
      const { value, done } = await reader.read();
      if (done) break;
      const take = Math.min(value.length, length - filled);
      bytes.set(value.subarray(0, take), filled);
      filled += take;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return new TextDecoder().decode(bytes.subarray(0, filled));
}

/** The fault an asset URL has, or null when it is the real file. */
export async function probeAsset(url: string, fetchImpl: FetchLike): Promise<AssetFault | null> {
  let res: Response;
  try {
    res = await fetchImpl(url);
  } catch {
    return 'missing';
  }
  if (!res.ok) return 'missing';
  const head = await readHead(res, LFS_POINTER_PREFIX.length).catch(() => '');
  return head === LFS_POINTER_PREFIX ? 'lfs-pointer' : null;
}

/**
 * The message shown on the mirror for a layer's broken assets: what is wrong
 * first, then the one command that fixes it.
 */
export function describeProblems(problems: readonly AssetProblem[]): string[] {
  if (problems.length === 0) return [];
  const names = problems.map((p) => p.path.split('/').pop() ?? p.path);
  const listed = names.slice(0, 2).join(', ');
  const rest = names.length > 2 ? ` and ${names.length - 2} more` : '';
  if (problems.every((p) => p.fault === 'lfs-pointer')) {
    return [
      `${listed}${rest} ${names.length === 1 ? 'is' : 'are'} Git LFS pointers, not the files.`,
      'Run "git lfs install" then "git lfs pull" in the GOSAI repository.',
    ];
  }
  return [
    `Missing ${listed}${rest}.`,
    'Rebuild the app, and run "git lfs pull" if the repository uses Git LFS.',
  ];
}

/**
 * Per-layer asset health. Layers `require` their files in `preload`; the guide
 * overlay reads `problems` every frame to decide whether to say so.
 */
export class AssetRegistry {
  private readonly faults = new Map<string, readonly AssetProblem[]>();

  constructor(
    private readonly resolve: (path: string) => string,
    private readonly onProblems: (slug: string, problems: readonly AssetProblem[]) => void,
    private readonly fetchImpl: FetchLike = (url) => fetch(url),
  ) {}

  /**
   * Records which of `paths` a layer can't use. Never rejects: a layer's
   * preload should not fail because the check itself did.
   */
  async require(slug: string, paths: readonly string[]): Promise<void> {
    const found: AssetProblem[] = [];
    await Promise.all(
      paths.map(async (path, index) => {
        const fault = await probeAsset(this.resolve(path), this.fetchImpl);
        if (fault) found[index] = { path, fault };
      }),
    );
    // `found` is sparse: compacting it keeps the layer's declaration order.
    const problems = found.filter((p): p is AssetProblem => p !== undefined);
    this.faults.set(slug, problems);
    if (problems.length > 0) this.onProblems(slug, problems);
  }

  problems(slug: string): readonly AssetProblem[] {
    return this.faults.get(slug) ?? [];
  }
}
