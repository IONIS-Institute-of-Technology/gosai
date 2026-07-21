/**
 * Optional embedded GOSAI server runner. Lets the packaged desktop app start
 * the server as a child process. In development, the server is launched
 * separately by `bun run dev`, so this only activates when packaged or when
 * `GOSAI_AUTOSTART_SERVER=1` is set.
 *
 * The child announces readiness with a `GOSAI_READY {"port":N,...}` stdout
 * line. Requesting port 0 lets the OS pick a free ephemeral port; callers
 * await `waitForReady()` to learn the actual address.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { app } from 'electron';

export interface ServerRunnerOptions {
  readonly port?: number;
  readonly host?: string;
  readonly serverBinPath?: string;
  readonly pythonDir?: string;
  readonly builtinAppsDir?: string;
  readonly homeDir?: string;
}

export interface ServerAddress {
  readonly host: string;
  readonly port: number;
}

const READY_PREFIX = 'GOSAI_READY ';

export function shouldAutostartServer(): boolean {
  if (process.env.GOSAI_AUTOSTART_SERVER === '0') return false;
  if (process.env.GOSAI_AUTOSTART_SERVER === '1') return true;
  return app.isPackaged;
}

export class ServerRunner {
  private child: ChildProcess | null = null;
  private readyPromise: Promise<ServerAddress> | null = null;

  constructor(private readonly options: ServerRunnerOptions = {}) {}

  shouldAutostart(): boolean {
    return shouldAutostartServer();
  }

  isRunning(): boolean {
    return this.child !== null;
  }

  start(): void {
    if (this.child) return;
    const command = this.resolveCommand();
    if (!command) {
      console.warn('[gosai-desktop] no server binary found; skipping autostart');
      return;
    }
    const host = this.options.host ?? '127.0.0.1';
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GOSAI_HOST: host,
      GOSAI_PORT: String(this.options.port ?? 7777),
    };
    if (this.options.pythonDir) env.GOSAI_PYTHON_DIR = this.options.pythonDir;
    if (this.options.builtinAppsDir) env.GOSAI_BUILTIN_APPS = this.options.builtinAppsDir;
    if (this.options.homeDir) env.GOSAI_HOME = this.options.homeDir;
    if (app.isPackaged && !env.GOSAI_SDK_RUNTIME) {
      env.GOSAI_SDK_RUNTIME = resolve(process.resourcesPath, 'sdk', 'browser.js');
    }

    const child = spawn(command.bin, command.args, {
      env,
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    this.child = child;

    let resolveReady: ((addr: ServerAddress) => void) | null = null;
    let rejectReady: ((err: Error) => void) | null = null;
    this.readyPromise = new Promise<ServerAddress>((res, rej) => {
      resolveReady = res;
      rejectReady = rej;
    });

    let buffer = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      process.stdout.write(chunk);
      if (!resolveReady) return;
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const idx = line.indexOf(READY_PREFIX);
        if (idx === -1) continue;
        try {
          const info = JSON.parse(line.slice(idx + READY_PREFIX.length)) as {
            port?: number;
            host?: string;
          };
          if (typeof info.port === 'number') {
            const resolveFn = resolveReady;
            resolveReady = null;
            rejectReady = null;
            resolveFn?.({ host: info.host ?? host, port: info.port });
            return;
          }
        } catch {
          // not our line; keep scanning
        }
      }
    });

    child.on('exit', (code, signal) => {
      console.log(`[gosai-desktop] server exited (code=${code} signal=${signal})`);
      this.child = null;
      rejectReady?.(new Error(`gosai-server exited before becoming ready (code=${code})`));
      rejectReady = null;
      resolveReady = null;
    });
    child.on('error', (err) => {
      this.child = null;
      rejectReady?.(err instanceof Error ? err : new Error(String(err)));
      rejectReady = null;
      resolveReady = null;
    });
  }

  /** Resolves once the child printed its GOSAI_READY line. */
  async waitForReady(timeoutMs = 30000): Promise<ServerAddress> {
    if (!this.readyPromise) throw new Error('server was not started');
    const timeout = new Promise<never>((_res, rej) => {
      setTimeout(() => rej(new Error('timed out waiting for gosai-server to start')), timeoutMs);
    });
    return await Promise.race([this.readyPromise, timeout]);
  }

  async stop(timeoutMs = 5000): Promise<void> {
    if (!this.child) return;
    const child = this.child;
    return new Promise<void>((resolveStop) => {
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
        resolveStop();
      }, timeoutMs);
      child.once('exit', () => {
        clearTimeout(timer);
        resolveStop();
      });
      try {
        child.kill('SIGTERM');
      } catch {
        clearTimeout(timer);
        resolveStop();
      }
    });
  }

  private resolveCommand(): { bin: string; args: string[] } | null {
    if (this.options.serverBinPath && existsSync(this.options.serverBinPath)) {
      return { bin: this.options.serverBinPath, args: [] };
    }
    if (process.env.GOSAI_SERVER_BIN && existsSync(process.env.GOSAI_SERVER_BIN)) {
      return { bin: process.env.GOSAI_SERVER_BIN, args: [] };
    }
    if (app.isPackaged) {
      // Phase 7 places the server here in production builds.
      const candidate = resolve(process.resourcesPath, 'server', 'gosai-server');
      if (existsSync(candidate)) return { bin: candidate, args: [] };
    }
    // Dev/local: run the server source with bun.
    const repoServer = resolve(__dirname, '..', '..', '..', 'server', 'src', 'index.ts');
    if (existsSync(repoServer)) {
      const bun = findBun();
      if (bun) {
        // Caller can opt-in via GOSAI_AUTOSTART_SERVER=1, otherwise we don't
        // spawn another instance.
        return { bin: bun, args: [repoServer] };
      }
    }
    return null;
  }
}

function findBun(): string | null {
  const path = process.env.BUN_BIN ?? join(process.env.HOME ?? '', '.bun', 'bin', 'bun');
  return existsSync(path) ? path : null;
}
