/**
 * When a kiosk quits. Main opens and closes the kiosk's windows by following
 * the server (see experience-windows.ts), so an app that switches experiences
 * with `rt.router.switchTo` closes one window and opens another. The kiosk
 * must not quit in between.
 *
 * - The user or the window manager closes an app window: quit with 0.
 * - The kiosk's own start of its experience fails, after its retries: quit
 *   with 1. Until that start settles, experiences that stop or crash don't
 *   count, so a failed attempt doesn't quit while the kiosk retries.
 * - The kiosk app's requested experiences have all stopped, and none starts
 *   within the grace period: quit with 0, or with 1 when the last one
 *   crashed, so a supervisor with `Restart=on-failure` restarts the kiosk.
 *
 * An exit with 1 carries the error the server reported, when there is one,
 * so the kiosk can show it before quitting.
 *
 * Experiences that only run as a requirement don't count. The server exiting
 * and a renderer crash are handled elsewhere and exit with 1.
 *
 * No Electron import, so tests can drive it.
 */

import type { RunningExperience } from '@gosai/shared';

export type KioskExit =
  | { readonly code: 0; readonly reason: string }
  | { readonly code: 1; readonly reason: string; readonly error?: string };

export interface KioskTimers {
  set(run: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface KioskLifecycleOptions {
  readonly appSlug: string;
  /** How long to wait for a start after the last experience stopped. */
  readonly graceMs?: number;
  exit(exit: KioskExit): void;
  readonly timers?: KioskTimers;
}

export const KIOSK_GRACE_MS = 3000;

const DEFAULT_TIMERS: KioskTimers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class KioskLifecycle {
  /** Requested experiences of the kiosk app that are starting, running or stopping. */
  private readonly active = new Set<string>();
  /** The last requested experience that stopped or crashed. */
  private lastStop: RunningExperience | null = null;
  /** Until `started()` or `startFailed()`, the kiosk's own start decides. */
  private starting = true;
  private timer: unknown = null;
  private exited = false;
  private readonly timers: KioskTimers;

  constructor(private readonly options: KioskLifecycleOptions) {
    this.timers = options.timers ?? DEFAULT_TIMERS;
  }

  onExperience(experience: RunningExperience): void {
    const { appSlug, experienceSlug, state, startedAs } = experience;
    if (this.exited || appSlug !== this.options.appSlug || startedAs !== 'request') return;
    if (state === 'idle' || state === 'crashed') {
      if (!this.active.delete(experienceSlug)) return;
      this.lastStop = experience;
      if (this.active.size === 0 && !this.starting) this.waitForStart(experience);
      return;
    }
    this.active.add(experienceSlug);
    this.cancelTimer();
  }

  /** The kiosk started its experience. Stops count from now on. */
  started(): void {
    if (!this.starting) return;
    this.starting = false;
    // It may already have stopped again.
    if (this.active.size === 0 && this.lastStop) this.waitForStart(this.lastStop);
  }

  /** The kiosk gave up starting its experience. `error` is the last attempt's. */
  startFailed(failure: { readonly experienceSlug: string; readonly error: string }): void {
    this.starting = false;
    this.finish({
      code: 1,
      reason: `${failure.experienceSlug} could not start`,
      error: failure.error,
    });
  }

  onWindowClosedByUser(): void {
    this.finish({ code: 0, reason: 'the app window was closed' });
  }

  dispose(): void {
    this.cancelTimer();
    this.exited = true;
  }

  private waitForStart(stopped: RunningExperience): void {
    this.cancelTimer();
    this.timer = this.timers.set(() => {
      this.timer = null;
      this.finish(
        stopped.state === 'crashed'
          ? {
              code: 1,
              reason: `${stopped.experienceSlug} crashed and no experience started after it`,
              ...(stopped.error !== undefined ? { error: stopped.error } : {}),
            }
          : { code: 0, reason: 'the app stopped its experiences' },
      );
    }, this.options.graceMs ?? KIOSK_GRACE_MS);
  }

  private cancelTimer(): void {
    if (this.timer === null) return;
    this.timers.clear(this.timer);
    this.timer = null;
  }

  private finish(exit: KioskExit): void {
    if (this.exited) return;
    this.dispose();
    this.options.exit(exit);
  }
}
