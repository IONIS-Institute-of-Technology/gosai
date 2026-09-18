/**
 * Node-side handle for one Python bridge process. Spawns
 * `python/.venv/bin/gosai-bridge`, or the command it is given, reads
 * newline-delimited JSON from its stdout, and forwards JSON requests to its
 * stdin.
 *
 * One process hosts every driver instance of the built-in drivers, or of one
 * app's drivers, as threads. Requests are multiplexed with `id`s. Restarting a
 * dead process is the supervisor's job (`supervisor.ts`); this class only
 * manages a single process lifetime.
 */

import { existsSync } from 'node:fs';
import type { Subprocess } from 'bun';
import type { DriverRuntimeInfo } from '@gosai/shared';
import {
  BRIDGE_PROTOCOL_VERSION,
  type BridgeRequest,
  type BridgeResponse,
} from '@gosai/shared/protocol';
import { bridgeExecutable } from '@gosai/shared/python-bridge';
import type { ChildLogger } from '../logger/logger.js';

/** Discriminated-union-friendly Omit<BridgeRequest, 'id'>. */
export type BridgeRequestSansId = BridgeRequest extends infer T
  ? T extends { id: string }
    ? Omit<T, 'id'>
    : never
  : never;

export interface BridgePerformanceSample {
  readonly instance: string;
  readonly source: string;
  readonly metric: string;
  readonly value: number;
  readonly ts: number;
}

/** Callbacks a bridge uses to report what the Python side does. */
export interface BridgeHandlers {
  readonly onEvent: (
    instance: string,
    driver: string,
    event: string,
    data: unknown,
    ts: number,
  ) => void;
  readonly onLog: (level: string, source: string, message: string, instance?: string) => void;
  readonly onDriverState: (
    instance: string,
    driver: string,
    state: string,
    runtime?: DriverRuntimeInfo,
  ) => void;
  readonly onPerformance: (sample: BridgePerformanceSample) => void;
  /** The process exited, whether or not `stop()` asked it to. */
  readonly onExit: (code: number | null, signal: number | string | null) => void;
}

export interface RequestOptions {
  readonly timeoutMs?: number;
}

/** What `DriverManager` needs from a bridge. Tests provide their own. */
export interface DriverBridge {
  start(): Promise<void>;
  stop(): Promise<void>;
  isRunning(): boolean;
  ping(timeoutMs: number): Promise<number>;
  request<T = unknown>(req: BridgeRequestSansId, options?: RequestOptions): Promise<T>;
}

export type DriverBridgeFactory = (handlers: BridgeHandlers) => DriverBridge;

export interface PythonBridgeOptions {
  /** The Python project whose `.venv` has `gosai-bridge`. Unused with `command`. */
  readonly pythonDir?: string;
  /** Runs this instead of `gosai-bridge`, such as an app's bridge in the app's environment. */
  readonly command?: readonly string[];
  /** Working directory. Defaults to `pythonDir`. */
  readonly cwd?: string;
  /** Variables added to the environment of the process. */
  readonly env?: Readonly<Record<string, string>>;
  readonly logger: ChildLogger;
  readonly handlers: BridgeHandlers;
  readonly readyTimeoutMs?: number;
  /** How long to wait for a clean exit after `shutdown` before SIGKILL. */
  readonly exitTimeoutMs?: number;
}

interface PendingRequest {
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_READY_TIMEOUT_MS = 15_000;
const DEFAULT_EXIT_TIMEOUT_MS = 10_000;
const SHUTDOWN_REPLY_TIMEOUT_MS = 2_000;

/**
 * Splits a stream of text chunks into lines. Each chunk is scanned once, so
 * parsing stays linear however large a pending line grows.
 */
export class LineSplitter {
  private parts: string[] = [];

  push(chunk: string, onLine: (line: string) => void): void {
    let start = 0;
    let newline = chunk.indexOf('\n');
    while (newline !== -1) {
      this.parts.push(chunk.slice(start, newline));
      const line = this.parts.join('');
      this.parts = [];
      onLine(line);
      start = newline + 1;
      newline = chunk.indexOf('\n', start);
    }
    if (start < chunk.length) this.parts.push(chunk.slice(start));
  }
}

export class PythonBridge implements DriverBridge {
  private process: Subprocess<'pipe', 'pipe', 'pipe'> | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private ready: { resolve: () => void; reject: (err: Error) => void } | null = null;
  private stopping = false;

  constructor(private readonly options: PythonBridgeOptions) {}

  isRunning(): boolean {
    return this.process !== null && !this.stopping && this.ready === null;
  }

  async start(): Promise<void> {
    if (this.process) throw new Error('Python bridge is already running');
    const cmd = this.options.command ?? [bridgeExecutable(this.options.pythonDir ?? '')];
    const executable = cmd[0] ?? '';
    if (!existsSync(executable)) {
      throw new Error(
        this.options.command
          ? `${executable} not found`
          : `gosai-bridge not found at ${executable}. Run \`uv sync\` inside the python/ directory.`,
      );
    }

    this.stopping = false;
    const readyPromise = new Promise<void>((resolve, reject) => {
      this.ready = { resolve, reject };
    });

    const env: Record<string, string | undefined> = {
      ...process.env,
      ...this.options.env,
      PYTHONUNBUFFERED: '1',
      // MediaPipe / TensorFlow write verbose native logs to stderr.
      GLOG_minloglevel: '2',
      TF_CPP_MIN_LOG_LEVEL: '2',
    };
    // Python drivers must not see the server's secret.
    delete env.GOSAI_DASHBOARD_TOKEN;

    const cwd = this.options.cwd ?? this.options.pythonDir;
    const proc = Bun.spawn({
      cmd: [...cmd],
      ...(cwd ? { cwd } : {}),
      env,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      onExit: (_proc, exitCode, signalCode, error) => {
        this.handleExit(proc, exitCode, signalCode, error);
      },
    });
    this.process = proc;
    void this.consumeStdout(proc);
    void this.consumeStderr(proc);

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        readyPromise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Python bridge did not signal ready in time')),
            this.options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
          );
        }),
      ]);
    } catch (err) {
      this.ready = null;
      await this.stop();
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Ask the bridge to shut down, close stdin, wait for exit, then SIGKILL. */
  async stop(): Promise<void> {
    const proc = this.process;
    if (!proc) return;
    this.stopping = true;
    try {
      await this.requestRaw(
        { type: 'shutdown', id: crypto.randomUUID() },
        SHUTDOWN_REPLY_TIMEOUT_MS,
      );
    } catch (err) {
      this.options.logger.debug('bridge did not acknowledge shutdown', { err: String(err) });
    }
    try {
      await proc.stdin.end();
    } catch (err) {
      this.options.logger.debug('closing bridge stdin failed', { err: String(err) });
    }
    const exitTimeoutMs = this.options.exitTimeoutMs ?? DEFAULT_EXIT_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const exited = await Promise.race([
      proc.exited.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), exitTimeoutMs);
      }),
    ]);
    clearTimeout(timer);
    if (!exited) {
      this.options.logger.warn('python bridge did not exit in time; killing it', {
        timeoutMs: exitTimeoutMs,
      });
      proc.kill('SIGKILL');
      await proc.exited;
    }
    // Report the exit now rather than whenever Bun's onExit callback runs.
    this.handleExit(proc, proc.exitCode, proc.signalCode, undefined);
  }

  async ping(timeoutMs: number): Promise<number> {
    const start = performance.now();
    await this.requestRaw({ type: 'ping', id: crypto.randomUUID() }, timeoutMs);
    return performance.now() - start;
  }

  /**
   * Send a request to the bridge. The caller supplies everything except `id`.
   * Distributes Omit over the BridgeRequest union to keep discriminated types.
   */
  request<T = unknown>(req: BridgeRequestSansId, options: RequestOptions = {}): Promise<T> {
    if (!this.isRunning()) return Promise.reject(new Error('Python bridge is not running'));
    return this.requestRaw(
      { ...req, id: crypto.randomUUID() } as BridgeRequest,
      options.timeoutMs,
    ) as Promise<T>;
  }

  private requestRaw(req: BridgeRequest, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const proc = this.process;
      if (!proc) {
        reject(new Error('Python bridge is not running'));
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(req.id);
        reject(new Error(`Bridge request ${req.type} (${req.id}) timed out`));
      }, timeoutMs);
      this.pending.set(req.id, { resolve, reject, timer });
      try {
        proc.stdin.write(`${JSON.stringify(req)}\n`);
        void proc.stdin.flush();
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(req.id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private async consumeStdout(proc: Subprocess<'pipe', 'pipe', 'pipe'>): Promise<void> {
    const decoder = new TextDecoder('utf8');
    const lines = new LineSplitter();
    const onLine = (line: string): void => this.handleLine(line);
    try {
      for await (const chunk of proc.stdout) {
        lines.push(decoder.decode(chunk, { stream: true }), onLine);
      }
      lines.push(`${decoder.decode()}\n`, onLine);
    } catch (err) {
      this.options.logger.error('stdout read failed', { err: String(err) });
    }
  }

  private async consumeStderr(proc: Subprocess<'pipe', 'pipe', 'pipe'>): Promise<void> {
    const decoder = new TextDecoder('utf8');
    const lines = new LineSplitter();
    const onLine = (line: string): void => {
      const trimmed = line.trim();
      if (trimmed.length > 0) this.logStderrLine(trimmed);
    };
    try {
      for await (const chunk of proc.stderr) {
        lines.push(decoder.decode(chunk, { stream: true }), onLine);
      }
      lines.push(`${decoder.decode()}\n`, onLine);
    } catch (err) {
      this.options.logger.error('stderr read failed', { err: String(err) });
    }
  }

  private handleLine(raw: string): void {
    const line = raw.trim();
    if (!line) return;
    let msg: BridgeResponse;
    try {
      msg = JSON.parse(line) as BridgeResponse;
    } catch {
      this.options.logger.warn(`invalid JSON from bridge: ${line}`);
      return;
    }

    const { handlers } = this.options;
    switch (msg.type) {
      case 'ready':
        this.handleReady(msg.version, msg.protocol);
        return;
      case 'pong':
        this.settle(msg.id, (pending) => pending.resolve(msg.ts));
        return;
      case 'result':
        this.settle(msg.id, (pending) => {
          if (msg.ok) pending.resolve(msg.data);
          else pending.reject(new Error(msg.error));
        });
        return;
      case 'event':
        handlers.onEvent(msg.instance, msg.driver, msg.event, msg.data, msg.ts);
        return;
      case 'log':
        handlers.onLog(msg.level, msg.source, msg.message, msg.instance);
        return;
      case 'driver-state':
        handlers.onDriverState(msg.instance, msg.driver, msg.state, msg.runtime);
        return;
      case 'performance':
        handlers.onPerformance({
          instance: msg.instance,
          source: msg.source,
          metric: msg.metric,
          value: msg.value,
          ts: msg.ts,
        });
        return;
      default:
        this.options.logger.warn(`unknown bridge message: ${line}`);
    }
  }

  private handleReady(version: string, protocol: number | undefined): void {
    const ready = this.ready;
    if (!ready) return;
    this.ready = null;
    if (protocol !== BRIDGE_PROTOCOL_VERSION) {
      ready.reject(
        new Error(
          `Python bridge speaks protocol ${String(protocol)}, expected ${BRIDGE_PROTOCOL_VERSION}. ` +
            'Run `uv sync` inside the python/ directory.',
        ),
      );
      return;
    }
    this.options.logger.info(`bridge ready (python v${version}, protocol ${protocol})`);
    ready.resolve();
  }

  private settle(id: string, apply: (pending: PendingRequest) => void): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    apply(pending);
  }

  private handleExit(
    proc: Subprocess<'pipe', 'pipe', 'pipe'>,
    exitCode: number | null,
    signalCode: number | string | null,
    error: Error | undefined,
  ): void {
    if (this.process !== proc) return;
    const reason = error ?? new Error(`Bridge exited (code=${exitCode}, signal=${signalCode})`);
    this.ready?.reject(reason);
    this.ready = null;
    this.process = null;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(reason);
      this.pending.delete(id);
    }
    this.options.handlers.onExit(exitCode, signalCode);
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
