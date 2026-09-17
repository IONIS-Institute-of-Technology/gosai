/**
 * Runs the GOSAI server as a child process of the desktop app.
 *
 * The server listens on 127.0.0.1 with port 0, so the OS picks a free port,
 * and announces it with a `GOSAI_READY {"port":N,...}` stdout line. Callers
 * await `waitForReady()` and hand the address to the windows.
 *
 * The child's stdin is a pipe it watches (GOSAI_EXIT_ON_STDIN_CLOSE=1). When
 * this process exits, even by crashing, the pipe closes and the server stops
 * its Python bridge and exits.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { app } from 'electron';

export interface ServerRunnerOptions {
  readonly pythonDir?: string;
  readonly builtinAppsDir?: string;
  readonly homeDir?: string;
  /** Dashboard token for this launch, passed to the server. */
  readonly dashboardToken: string;
}

export interface ServerAddress {
  readonly host: string;
  readonly port: number;
}

/** Called when the server exits without `stop()` asking it to. */
export type UnexpectedExitListener = (description: string) => void;

const HOST = '127.0.0.1';
const READY_PREFIX = 'GOSAI_READY ';
const EXE = process.platform === 'win32' ? '.exe' : '';

/**
 * Origins of the dashboard window, which loads from `file://`. App windows
 * run on their own `http://<slug>.localhost` origins, which the server allows.
 */
const DASHBOARD_ORIGINS = ['file://', 'null'];

/**
 * The packaged app starts its own server. From source, `bun run dev` starts
 * one separately, unless GOSAI_AUTOSTART_SERVER=1.
 */
export function shouldAutostartServer(): boolean {
  if (process.env.GOSAI_AUTOSTART_SERVER === '0') return false;
  if (process.env.GOSAI_AUTOSTART_SERVER === '1') return true;
  return app.isPackaged;
}

export class ServerRunner {
  private child: ChildProcess | null = null;
  private readyPromise: Promise<ServerAddress> | null = null;
  private stopping = false;
  private readonly exitListeners: UnexpectedExitListener[] = [];

  constructor(private readonly options: ServerRunnerOptions) {}

  isRunning(): boolean {
    return this.child !== null;
  }

  onUnexpectedExit(listener: UnexpectedExitListener): void {
    this.exitListeners.push(listener);
  }

  /** Spawns the server. Throws when no server executable can be found. */
  start(): void {
    if (this.child) return;
    const command = resolveCommand();
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GOSAI_HOST: HOST,
      GOSAI_PORT: '0',
      GOSAI_EXIT_ON_STDIN_CLOSE: '1',
      GOSAI_DASHBOARD_TOKEN: this.options.dashboardToken,
      GOSAI_ALLOWED_ORIGINS: [process.env.GOSAI_ALLOWED_ORIGINS, ...DASHBOARD_ORIGINS]
        .filter(Boolean)
        .join(','),
    };
    if (this.options.pythonDir) env.GOSAI_PYTHON_DIR = this.options.pythonDir;
    if (this.options.builtinAppsDir) env.GOSAI_BUILTIN_APPS = this.options.builtinAppsDir;
    if (this.options.homeDir) env.GOSAI_HOME = this.options.homeDir;
    if (app.isPackaged && !env.GOSAI_SDK_DIR) {
      env.GOSAI_SDK_DIR = resolve(process.resourcesPath, 'sdk');
    }

    const child = spawn(command.bin, command.args, {
      env,
      stdio: ['pipe', 'pipe', 'inherit'],
      windowsHide: true,
    });
    this.child = child;
    // Nothing is written to the pipe; it only has to stay open.
    child.stdin?.on('error', () => undefined);

    let resolveReady: ((addr: ServerAddress) => void) | null = null;
    let rejectReady: ((err: Error) => void) | null = null;
    this.readyPromise = new Promise<ServerAddress>((res, rej) => {
      resolveReady = res;
      rejectReady = rej;
    });
    // A rejection nobody awaits yet must not crash the main process.
    this.readyPromise.catch(() => undefined);

    let buffer = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      process.stdout.write(chunk);
      if (!resolveReady) return;
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const address = parseReadyLine(line);
        if (!address) continue;
        const resolveFn = resolveReady;
        resolveReady = null;
        rejectReady = null;
        resolveFn?.(address);
        return;
      }
    });

    const onGone = (description: string, error: Error): void => {
      if (this.child !== child) return;
      this.child = null;
      const wasReady = rejectReady === null;
      rejectReady?.(error);
      rejectReady = null;
      resolveReady = null;
      console.log(`[gosai-desktop] server ${description}`);
      if (!this.stopping && wasReady) {
        for (const listener of this.exitListeners) listener(description);
      }
    };
    child.on('exit', (code, signal) => {
      const description =
        signal !== null ? `was killed by ${signal}` : `exited with code ${code ?? 'unknown'}`;
      onGone(description, new Error(`gosai-server ${description} before it was ready`));
    });
    child.on('error', (err) => {
      onGone(`could not run (${err.message})`, new Error(`could not run gosai-server: ${err}`));
    });
  }

  /** Resolves once the child printed its GOSAI_READY line. */
  async waitForReady(timeoutMs = 30000): Promise<ServerAddress> {
    if (!this.readyPromise) throw new Error('server was not started');
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_res, rej) => {
      timer = setTimeout(
        () => rej(new Error(`gosai-server did not start within ${timeoutMs / 1000} s`)),
        timeoutMs,
      );
    });
    try {
      return await Promise.race([this.readyPromise, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Closes the server's stdin, which starts its shutdown, and signals it on
   * POSIX too. Kills it if it is still running after `timeoutMs`.
   */
  async stop(timeoutMs = 10000): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    await new Promise<void>((resolveStop) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolveStop();
      }, timeoutMs);
      child.once('exit', () => {
        clearTimeout(timer);
        resolveStop();
      });
      child.stdin?.end();
      // On Windows kill() terminates at once, so only the pipe asks politely.
      if (process.platform !== 'win32') child.kill('SIGTERM');
    });
  }
}

export function parseReadyLine(line: string): ServerAddress | null {
  const idx = line.indexOf(READY_PREFIX);
  if (idx === -1) return null;
  try {
    const info = JSON.parse(line.slice(idx + READY_PREFIX.length)) as {
      port?: unknown;
      host?: unknown;
    };
    if (typeof info.port !== 'number') return null;
    return { host: typeof info.host === 'string' ? info.host : HOST, port: info.port };
  } catch {
    return null;
  }
}

function resolveCommand(): { bin: string; args: string[] } {
  const override = process.env.GOSAI_SERVER_BIN;
  if (override) {
    if (!existsSync(override)) throw new Error(`GOSAI_SERVER_BIN does not exist: ${override}`);
    return { bin: override, args: [] };
  }
  if (app.isPackaged) {
    const bundled = join(process.resourcesPath, 'server', `gosai-server${EXE}`);
    if (!existsSync(bundled)) throw new Error(`the bundled server is missing at ${bundled}`);
    return { bin: bundled, args: [] };
  }
  // From source: run the server with bun. out/main -> packages/server.
  const source = resolve(import.meta.dirname, '..', '..', '..', 'server', 'src', 'index.ts');
  if (!existsSync(source)) throw new Error(`the server source is missing at ${source}`);
  const bun = findBun();
  if (!bun) throw new Error('bun was not found; set BUN_BIN or add bun to PATH');
  return { bin: bun, args: [source] };
}

function findBun(): string | null {
  const candidates = [
    process.env.BUN_BIN,
    join(process.env.HOME ?? process.env.USERPROFILE ?? '', '.bun', 'bin', `bun${EXE}`),
    ...(process.env.PATH ?? '').split(delimiter).map((dir) => dir && join(dir, `bun${EXE}`)),
  ];
  return candidates.find((path): path is string => !!path && existsSync(path)) ?? null;
}
