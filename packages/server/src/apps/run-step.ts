/**
 * Runs an install step as a child process: output streams to the logger line
 * by line, the step is killed after its timeout, and a failure carries the
 * last lines of output.
 */

import type { ChildLogger } from '../logger/logger.js';

/** How long to keep reading output after a killed step exits. */
const OUTPUT_GRACE_MS = 1000;
const ERROR_TAIL_LINES = 20;

export interface StepOptions {
  readonly label: string;
  readonly cmd: string[];
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly timeoutMs: number;
  readonly logger: ChildLogger;
  /** Kills the step when aborted, which rejects. */
  readonly signal?: AbortSignal;
  /**
   * Run the step in a process group of its own and kill the whole group on
   * timeout or abort, so tools that start their own processes (uv building a
   * package) leave nothing behind. POSIX only.
   */
  readonly processGroup?: boolean;
}

export interface StepResult {
  readonly code: number;
  /** Last lines of combined stdout and stderr. */
  readonly tail: readonly string[];
}

/**
 * Runs one install step. stdout and stderr stream to the logger line by line,
 * so a noisy step can't fill a pipe and block. The step is killed after
 * `timeoutMs` or when `signal` aborts, which rejects.
 */
export async function runStep(opts: StepOptions): Promise<StepResult> {
  const env: Record<string, string | undefined> = { ...process.env, ...opts.env };
  // App build scripts are third-party code and must not see server secrets.
  delete env.GOSAI_DASHBOARD_TOKEN;
  opts.signal?.throwIfAborted();

  const group = opts.processGroup === true && process.platform !== 'win32';
  const child = Bun.spawn({
    cmd: opts.cmd,
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    ...(group ? { detached: true } : {}),
  });
  const kill = (): void => {
    if (group) {
      try {
        process.kill(-child.pid, 'SIGKILL');
        return;
      } catch {
        // The group is gone already; kill the child itself below.
      }
    }
    child.kill('SIGKILL');
  };

  const tail: string[] = [];
  const onLine = (line: string, stream: 'stdout' | 'stderr'): void => {
    if (line.trim() === '') return;
    opts.logger.info(`[${opts.label}] ${line}`, { stream });
    tail.push(line);
    if (tail.length > ERROR_TAIL_LINES) tail.shift();
  };
  const readers = [child.stdout.getReader(), child.stderr.getReader()] as const;
  const pumps = Promise.all([
    pumpLines(readers[0], (line) => onLine(line, 'stdout')),
    pumpLines(readers[1], (line) => onLine(line, 'stderr')),
  ]);

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, opts.timeoutMs);
  let aborted = false;
  const onAbort = (): void => {
    aborted = true;
    kill();
  };
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  const code = await child.exited;
  clearTimeout(timer);
  opts.signal?.removeEventListener('abort', onAbort);

  // A killed step can leave grandchildren holding the pipes open, so stop
  // reading after a short grace period.
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const grace = new Promise<void>((resolve) => {
    graceTimer = setTimeout(resolve, OUTPUT_GRACE_MS);
  });
  await Promise.race([pumps, grace]);
  clearTimeout(graceTimer);
  for (const reader of readers) void reader.cancel().catch(() => undefined);

  if (aborted) throw new Error(`${opts.label} was cancelled`);
  if (timedOut) {
    throw new Error(`${opts.label} timed out after ${Math.round(opts.timeoutMs / 1000)}s`);
  }
  return { code, tail };
}

export async function runChecked(opts: StepOptions): Promise<void> {
  const result = await runStep(opts);
  if (result.code !== 0) throw stepError(opts.label, result);
}

function stepError(label: string, result: StepResult): Error {
  const output = result.tail.join('\n').trim();
  return new Error(`${label} failed (exit ${result.code}): ${output || 'no output'}`);
}

interface ChunkReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
}

async function pumpLines(reader: ChunkReader, onLine: (line: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) onLine(line);
    }
  } catch {
    // Reader cancelled after a timeout.
  }
  buffer += decoder.decode();
  if (buffer !== '') onLine(buffer);
}
