/**
 * When a kiosk quits. Main opens and closes the kiosk's windows by following
 * the server (see experience-windows.ts), so an app that switches experiences
 * with `rt.router.switchTo` closes one window and opens another. The kiosk
 * must not quit in between.
 *
 * - The user or the window manager closes an app window: quit with 0.
 * - The kiosk app's requested experiences have all stopped, and none starts
 *   within the grace period: quit with 0, or with 1 when the last one
 *   crashed, so a supervisor with `Restart=on-failure` restarts the kiosk.
 *
 * Experiences that only run as a requirement don't count. The server exiting
 * and a renderer crash are handled elsewhere and exit with 1.
 *
 * No Electron import, so tests can drive it.
 */

import type { RunningExperience } from '@gosai/shared';

export interface KioskExit {
  readonly code: 0 | 1;
  readonly reason: string;
}

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
  private timer: unknown = null;
  private exited = false;
  private readonly timers: KioskTimers;

  constructor(private readonly options: KioskLifecycleOptions) {
    this.timers = options.timers ?? DEFAULT_TIMERS;
  }

  onExperience({ appSlug, experienceSlug, state, startedAs }: RunningExperience): void {
    if (this.exited || appSlug !== this.options.appSlug || startedAs !== 'request') return;
    if (state === 'idle' || state === 'crashed') {
      if (!this.active.delete(experienceSlug) || this.active.size > 0) return;
      this.waitForStart(state === 'crashed', experienceSlug);
      return;
    }
    this.active.add(experienceSlug);
    this.cancelTimer();
  }

  onWindowClosedByUser(): void {
    this.finish({ code: 0, reason: 'the app window was closed' });
  }

  dispose(): void {
    this.cancelTimer();
    this.exited = true;
  }

  private waitForStart(crashed: boolean, experienceSlug: string): void {
    this.cancelTimer();
    this.timer = this.timers.set(() => {
      this.timer = null;
      this.finish(
        crashed
          ? { code: 1, reason: `${experienceSlug} crashed and no experience started after it` }
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
