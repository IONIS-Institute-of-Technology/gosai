/**
 * Optional embedded GOSAI server runner. Lets the packaged desktop app start
 * the server as a child process. In development, the server is launched
 * separately by `bun run dev`, so this only activates when packaged or when
 * `GOSAI_AUTOSTART_SERVER=1` is set.
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
}

export class ServerRunner {
  private child: ChildProcess | null = null;

  constructor(private readonly options: ServerRunnerOptions = {}) {}

  shouldAutostart(): boolean {
    if (process.env.GOSAI_AUTOSTART_SERVER === '0') return false;
    if (process.env.GOSAI_AUTOSTART_SERVER === '1') return true;
    return app.isPackaged;
  }

  isRunning(): boolean {
    return this.child !== null;
  }

  start(): void {
    if (this.child) return;
    const bin = this.resolveBin();
    if (!bin) {
      console.warn('[gosai-desktop] no server binary found; skipping autostart');
      return;
    }
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GOSAI_HOST: this.options.host ?? '127.0.0.1',
      GOSAI_PORT: String(this.options.port ?? 7777),
    };
    if (this.options.pythonDir) env.GOSAI_PYTHON_DIR = this.options.pythonDir;
    if (this.options.builtinAppsDir) env.GOSAI_BUILTIN_APPS = this.options.builtinAppsDir;
    this.child = spawn(bin, [], { env, stdio: 'inherit' });
    this.child.on('exit', (code, signal) => {
      console.log(`[gosai-desktop] server exited (code=${code} signal=${signal})`);
      this.child = null;
    });
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

  private resolveBin(): string | null {
    if (this.options.serverBinPath && existsSync(this.options.serverBinPath)) {
      return this.options.serverBinPath;
    }
    if (process.env.GOSAI_SERVER_BIN && existsSync(process.env.GOSAI_SERVER_BIN)) {
      return process.env.GOSAI_SERVER_BIN;
    }
    if (app.isPackaged) {
      // Phase 7 places the server here in production builds.
      const candidate = resolve(process.resourcesPath, 'server', 'gosai-server');
      if (existsSync(candidate)) return candidate;
    }
    // Dev/local: try `bun` running the source.
    const repoServer = resolve(__dirname, '..', '..', '..', 'server', 'src', 'index.ts');
    if (existsSync(repoServer)) {
      const bun = findBun();
      if (bun) {
        // Caller can opt-in via GOSAI_AUTOSTART_SERVER=1, otherwise we don't
        // spawn another instance.
        return bun;
      }
    }
    return null;
  }
}

function findBun(): string | null {
  const path = process.env.BUN_BIN ?? join(process.env.HOME ?? '', '.bun', 'bin', 'bun');
  return existsSync(path) ? path : null;
}
