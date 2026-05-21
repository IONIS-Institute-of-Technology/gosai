/**
 * Node-side handle for the long-running Python bridge process. Spawns
 * `python/.venv/bin/gosai-bridge` (or the `gosai-bridge` console script), reads
 * newline-delimited JSON from its stdout, and forwards JSON requests to its
 * stdin.
 *
 * One PythonBridge instance hosts all drivers; the bridge process itself runs
 * the drivers as threads. The Node side multiplexes requests with `id`s.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Subprocess } from 'bun';
import type {
  BridgeRequest,
  BridgeResponse,
} from '@gosai/shared/protocol';

/** Discriminated-union-friendly Omit<BridgeRequest, 'id'>. */
export type BridgeRequestSansId = BridgeRequest extends infer T
  ? T extends { id: string }
    ? Omit<T, 'id'>
    : never
  : never;
import type { ChildLogger } from '../logger/index.js';

export interface BridgeOptions {
  readonly pythonDir: string;
  readonly venvName?: string;
  readonly env?: Record<string, string>;
  readonly logger: ChildLogger;
  readonly onEvent: (driver: string, event: string, data: unknown, ts: number) => void;
  readonly onLog: (level: string, source: string, message: string) => void;
  readonly onDriverState: (driver: string, state: string) => void;
  readonly onPerformance: (source: string, metric: string, value: number, ts: number) => void;
  readonly onExit?: (code: number | null, signal: number | null) => void;
}

interface PendingRequest {
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const REQUEST_TIMEOUT_MS = 30_000;

export class PythonBridge {
  private process: Subprocess<'pipe', 'pipe', 'pipe'> | null = null;
  private buffer = '';
  private readonly pending = new Map<string, PendingRequest>();
  private readyPromise: Promise<void> | null = null;
  private resolveReady: (() => void) | null = null;
  private rejectReady: ((err: Error) => void) | null = null;
  private starting = false;
  private stopping = false;

  constructor(private readonly options: BridgeOptions) {}

  isRunning(): boolean {
    return this.process !== null && !this.stopping;
  }

  async start(): Promise<void> {
    if (this.isRunning()) return;
    if (this.starting) {
      if (this.readyPromise) await this.readyPromise;
      return;
    }

    this.starting = true;
    this.stopping = false;
    this.buffer = '';

    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });

    const { pythonDir, venvName = '.venv' } = this.options;
    const venvBin = join(pythonDir, venvName, 'bin');
    const bridgeBin = join(venvBin, 'gosai-bridge');

    if (!existsSync(bridgeBin)) {
      const err = new Error(
        `gosai-bridge not found at ${bridgeBin}. Run \`uv sync\` inside the python/ directory.`,
      );
      this.starting = false;
      this.readyPromise = null;
      this.resolveReady = null;
      this.rejectReady = null;
      throw err;
    }

    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ...(this.options.env ?? {}),
      PYTHONUNBUFFERED: '1',
      // MediaPipe / TensorFlow write verbose native logs to stderr.
      GLOG_minloglevel: '2',
      TF_CPP_MIN_LOG_LEVEL: '2',
    };

    this.process = Bun.spawn({
      cmd: [bridgeBin],
      cwd: pythonDir,
      env,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      onExit: (_proc, exitCode, signalCode, error) => {
        this.handleExit(exitCode, signalCode, error);
      },
    });

    void this.consumeStdout();
    void this.consumeStderr();

    try {
      await Promise.race([
        this.readyPromise,
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error('Python bridge did not signal ready in time')), 15_000),
        ),
      ]);
    } catch (err) {
      this.starting = false;
      try {
        await this.stop();
      } catch {
        // best-effort
      }
      throw err;
    }

    this.starting = false;
  }

  async stop(timeoutMs = 5_000): Promise<void> {
    if (!this.process) return;
    this.stopping = true;
    try {
      await this.requestRaw({ type: 'shutdown', id: cryptoId() } as BridgeRequest, 1_000).catch(
        () => undefined,
      );
    } catch {
      // ignore
    }
    const proc = this.process;
    if (!proc) return;
    try {
      proc.kill();
    } catch {
      // already dead
    }
    await Promise.race([
      proc.exited,
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
    this.process = null;
    this.failAllPending(new Error('Python bridge stopped'));
  }

  async ping(): Promise<number> {
    const id = cryptoId();
    const start = performance.now();
    await this.requestRaw({ type: 'ping', id }, 5_000);
    return performance.now() - start;
  }

  /**
   * Send a request to the bridge. The caller supplies everything except `id`.
   * Distributes Omit over the BridgeRequest union to keep discriminated types.
   */
  request<T = unknown>(req: BridgeRequestSansId): Promise<T> {
    const id = cryptoId();
    return this.requestRaw({ ...req, id } as BridgeRequest) as Promise<T>;
  }

  private requestRaw(req: BridgeRequest, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      if (!this.process) {
        reject(new Error('Python bridge is not running'));
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(req.id);
        reject(new Error(`Bridge request ${req.type} (${req.id}) timed out`));
      }, timeoutMs);
      this.pending.set(req.id, { resolve, reject, timer });
      try {
        this.writeLine(JSON.stringify(req));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(req.id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private writeLine(line: string): void {
    const stdin = this.process?.stdin;
    if (!stdin) throw new Error('Python bridge stdin not open');
    stdin.write(`${line}\n`);
  }

  private async consumeStdout(): Promise<void> {
    const stream = this.process?.stdout;
    if (!stream) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder('utf8');
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        this.buffer += decoder.decode(value, { stream: true });
        this.flushBuffer();
      }
    } catch (err) {
      this.options.logger.error('stdout read failed', { err: String(err) });
    }
  }

  private async consumeStderr(): Promise<void> {
    const stream = this.process?.stderr;
    if (!stream) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder('utf8');
    let leftover = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = leftover + decoder.decode(value, { stream: true });
        const lines = text.split('\n');
        leftover = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.length === 0) continue;
          this.logStderrLine(trimmed);
        }
      }
      const tail = leftover.trim();
      if (tail.length > 0) {
        this.logStderrLine(tail);
      }
    } catch (err) {
      this.options.logger.error('stderr read failed', { err: String(err) });
    }
  }

  private flushBuffer(): void {
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let msg: BridgeResponse;
    try {
      msg = JSON.parse(line) as BridgeResponse;
    } catch {
      this.options.logger.warn(`invalid JSON from bridge: ${line}`);
      return;
    }

    switch (msg.type) {
      case 'ready':
        if (this.resolveReady) {
          this.resolveReady();
          this.resolveReady = null;
          this.rejectReady = null;
        }
        this.options.logger.info(`bridge ready (python v${msg.version})`);
        return;
      case 'pong': {
        const pending = this.pending.get(msg.id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(msg.id);
          pending.resolve(msg.ts);
        }
        return;
      }
      case 'result': {
        const pending = this.pending.get(msg.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(msg.id);
        if (msg.ok) pending.resolve(msg.data);
        else pending.reject(new Error(msg.error));
        return;
      }
      case 'event':
        this.options.onEvent(msg.driver, msg.event, msg.data, msg.ts);
        return;
      case 'log':
        this.options.onLog(msg.level, msg.source, msg.message);
        return;
      case 'driver-state':
        this.options.onDriverState(msg.driver, msg.state);
        return;
      case 'performance':
        this.options.onPerformance(msg.source, msg.metric, msg.value, msg.ts);
        return;
      default:
        this.options.logger.warn(`unknown bridge message: ${line}`);
    }
  }

  private handleExit(
    exitCode: number | null,
    signalCode: number | null,
    error: Error | undefined,
  ): void {
    if (this.rejectReady) {
      this.rejectReady(error ?? new Error(`Bridge exited (code=${exitCode}, signal=${signalCode})`));
      this.resolveReady = null;
      this.rejectReady = null;
    }
    this.failAllPending(error ?? new Error('Bridge process exited'));
    this.process = null;
    this.options.onExit?.(exitCode, signalCode);
  }

  private logStderrLine(line: string): void {
    if (isPythonTracebackLine(line)) {
      this.options.logger.error(line);
      return;
    }
    if (classifyNativeStderrLine(line) === 'debug') {
      this.options.logger.debug(line);
    } else {
      this.options.logger.warn(line);
    }
  }

  private failAllPending(err: Error): void {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      pending.reject(err);
      this.pending.delete(id);
    }
  }
}

function cryptoId(): string {
  return crypto.randomUUID();
}

function isPythonTracebackLine(line: string): boolean {
  return (
    line.startsWith('Traceback (most recent call last)') ||
    line.startsWith('  File ') ||
    /^[\w.]+Error:/.test(line) ||
    /^[\w.]+Exception:/.test(line) ||
    line === 'During handling of the above exception, another exception occurred:'
  );
}

/** absl/glog and MediaPipe often print INFO/W lines to stderr. */
function classifyNativeStderrLine(line: string): 'debug' | 'warn' {
  if (/^[IWEF]\d{4}\s/.test(line)) return 'debug';
  if (line.startsWith('INFO:') || line.startsWith('WARNING:')) return 'debug';
  if (
    line.includes('init-domain.cc') ||
    line.includes('gl_context.cc') ||
    line.includes('TensorFlow Lite XNNPACK') ||
    line.includes('inference_feedback_manager.cc') ||
    line.includes('landmark_projection_calculator.cc')
  ) {
    return 'debug';
  }
  return 'warn';
}
