/**
 * Keeps one Python bridge alive. Restarts it with exponential backoff when it
 * exits or stops answering pings, and tells the driver manager when a fresh
 * bridge is ready so it can re-apply the desired driver state.
 */

import type { ChildLogger } from '../logger/index.js';
import type { DriverBridge } from './bridge.js';

export interface SupervisorTiming {
  readonly initialBackoffMs: number;
  readonly maxBackoffMs: number;
  /** A bridge that stayed up this long resets the backoff. */
  readonly stableAfterMs: number;
  readonly pingIntervalMs: number;
  readonly pingTimeoutMs: number;
  /** Consecutive failed pings before the bridge is restarted. */
  readonly maxMissedPings: number;
}

export const DEFAULT_SUPERVISOR_TIMING: SupervisorTiming = {
  initialBackoffMs: 500,
  maxBackoffMs: 30_000,
  stableAfterMs: 60_000,
  pingIntervalMs: 5_000,
  pingTimeoutMs: 5_000,
  maxMissedPings: 3,
};

export interface BridgeSupervisorOptions {
  readonly bridge: DriverBridge;
  readonly log: ChildLogger;
  /** Runs after every successful start, before the bridge counts as up. */
  readonly onReady: () => Promise<void>;
  /** Runs when a bridge goes away or fails to come up. Must be idempotent. */
  readonly onDown: () => void;
  readonly timing?: Partial<SupervisorTiming>;
}

type SupervisorState = 'idle' | 'starting' | 'up' | 'waiting' | 'stopped';

export class BridgeSupervisor {
  private state: SupervisorState = 'idle';
  private readonly timing: SupervisorTiming;
  private attempt = 0;
  private upSince = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private missedPings = 0;
  private pinging = false;
  private starting: Promise<void> | null = null;

  constructor(private readonly options: BridgeSupervisorOptions) {
    this.timing = { ...DEFAULT_SUPERVISOR_TIMING, ...options.timing };
  }

  isUp(): boolean {
    return this.state === 'up';
  }

  /** Reads the field afresh, since `stop()` can change it across an await. */
  private isStopped(): boolean {
    return this.state === 'stopped';
  }

  /**
   * Start the bridge. Rejects if the first attempt fails, but keeps retrying in
   * the background until `stop()`.
   */
  async start(): Promise<void> {
    if (this.state === 'up') return;
    if (this.starting) return this.starting;
    this.clearRestartTimer();
    this.starting = this.attemptStart();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  async stop(): Promise<void> {
    this.state = 'stopped';
    this.clearRestartTimer();
    this.stopPinging();
    // Stop the process first so a start waiting on ready or on the catalogue
    // fails right away instead of running to its timeout.
    await this.options.bridge.stop();
    await this.starting?.catch(() => undefined);
    await this.options.bridge.stop();
  }

  /** Wire to the bridge's exit handler. */
  handleExit(code: number | null, signal: number | string | null): void {
    if (this.state !== 'up') return;
    this.options.log.warn('python bridge exited unexpectedly', { code, signal });
    this.goDown();
  }

  private async attemptStart(): Promise<void> {
    this.state = 'starting';
    try {
      await this.options.bridge.start();
      await this.options.onReady();
      if (!this.options.bridge.isRunning()) throw new Error('python bridge exited during startup');
    } catch (err) {
      if (this.isStopped()) throw err;
      this.options.onDown();
      await this.options.bridge.stop().catch((stopErr: unknown) => {
        this.options.log.warn('failed to stop a bridge that did not start', {
          err: String(stopErr),
        });
      });
      this.scheduleRestart(err);
      throw err;
    }
    if (this.isStopped()) return;
    this.state = 'up';
    this.upSince = Date.now();
    this.startPinging();
  }

  private goDown(): void {
    this.stopPinging();
    if (Date.now() - this.upSince >= this.timing.stableAfterMs) this.attempt = 0;
    this.options.onDown();
    this.scheduleRestart(undefined);
  }

  private scheduleRestart(reason: unknown): void {
    if (this.state === 'stopped') return;
    this.state = 'waiting';
    const delay = Math.min(
      this.timing.initialBackoffMs * 2 ** this.attempt,
      this.timing.maxBackoffMs,
    );
    this.attempt += 1;
    this.options.log.warn('restarting python bridge', {
      delayMs: delay,
      attempt: this.attempt,
      ...(reason !== undefined ? { err: String(reason) } : {}),
    });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.start().catch(() => {
        // attemptStart already logged and scheduled the next attempt.
      });
    }, delay);
  }

  private clearRestartTimer(): void {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }

  private startPinging(): void {
    this.missedPings = 0;
    this.pingTimer = setInterval(() => void this.checkHealth(), this.timing.pingIntervalMs);
  }

  private stopPinging(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private async checkHealth(): Promise<void> {
    if (this.pinging || this.state !== 'up') return;
    this.pinging = true;
    try {
      await this.options.bridge.ping(this.timing.pingTimeoutMs);
      this.missedPings = 0;
    } catch (err) {
      this.missedPings += 1;
      this.options.log.warn('python bridge missed a ping', {
        missed: this.missedPings,
        err: String(err),
      });
      if (this.missedPings >= this.timing.maxMissedPings && this.state === 'up') {
        this.state = 'waiting';
        this.stopPinging();
        await this.options.bridge.stop();
        if (this.state === 'waiting') this.goDown();
      }
    } finally {
      this.pinging = false;
    }
  }
}
