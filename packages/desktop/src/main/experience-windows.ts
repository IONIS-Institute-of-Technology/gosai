/**
 * Keeps an app window open for every experience a client started, in the
 * desktop app and in kiosks.
 *
 * Main follows the server's `experience:state-changed` events instead of
 * waiting for the dashboard to ask for a window, so an experience started or
 * stopped anywhere gets its window opened or closed: from the dashboard, from
 * an app calling `rt.router.switchTo`, from another client, or by a crash.
 *
 * - `running` with `startedAs: 'request'`: resolves the display and opens a
 *   window, unless the experience already has one or someone claimed it.
 *   Experiences that only run because another one requires them stay
 *   headless. The calibration flow claims its experience because it opens
 *   its own control and projector windows.
 * - `idle` (stopped) or `crashed`: closes the experience's windows.
 * - Every (re)connection compares the windows this controller opened with
 *   `experiences:list`, since events sent while disconnected are lost.
 *
 * No Electron import, so tests can drive it with fakes.
 */

import type { RunningExperience } from '@gosai/shared';
import type { ServerClient } from '@gosai/shared/client';
import { resolveAppDisplay, type DisplaySource, type ResolvedDisplay } from './displays.js';
import type { OpenAppHostOptions } from './windows.js';

export type ExperienceWindowServer = Pick<ServerClient, 'request' | 'on' | 'onStatus'>;

/** The parts of the WindowRegistry the controller uses. */
export interface ExperienceWindowHost extends DisplaySource {
  readonly server: ExperienceWindowServer;
  /** Experiences with at least one open window. */
  openExperiences(): readonly { readonly appSlug: string; readonly experienceSlug: string }[];
  openAppHost(options: OpenAppHostOptions): unknown;
  /** Closes the experience's windows without stopping it on the server. */
  closeExperienceWindows(appSlug: string, experienceSlug: string): unknown;
}

export interface ExperienceWindowsOptions {
  /** Where an app's window opens. Defaults to the app's display assignment (see displays.ts). */
  readonly resolveDisplay?: (appSlug: string) => Promise<ResolvedDisplay> | ResolvedDisplay;
  readonly log?: (message: string, err?: unknown) => void;
}

type Key = `${string}/${string}`;

function keyOf(appSlug: string, experienceSlug: string): Key {
  return `${appSlug}/${experienceSlug}`;
}

export class ExperienceWindows {
  /** Last known state of each experience the server reported. */
  private readonly states = new Map<Key, RunningExperience['state']>();
  private readonly claims = new Map<Key, number>();
  /** Experiences whose display is being resolved, to open one window each. */
  private readonly opening = new Set<Key>();
  /** Experiences this controller opened a window for. */
  private readonly opened = new Set<Key>();
  private offs: Array<() => void> = [];
  private readonly log: (message: string, err?: unknown) => void;

  constructor(
    private readonly host: ExperienceWindowHost,
    private readonly options: ExperienceWindowsOptions = {},
  ) {
    this.log =
      options.log ?? ((message, err) => console.error(`[gosai-desktop] ${message}`, err ?? ''));
  }

  /** Starts following the server. Call `stop()` before quitting. */
  start(): void {
    if (this.offs.length > 0) return;
    const server = this.host.server;
    this.offs = [
      server.on('experience:state-changed', (experience) => this.apply(experience)),
      server.onStatus((status) => {
        if (status === 'connected') void this.reconcile();
      }),
    ];
  }

  stop(): void {
    for (const off of this.offs.splice(0)) off();
    this.opening.clear();
  }

  /**
   * Keeps the controller from opening a window for the experience until the
   * returned function is called. It still closes the experience's windows
   * when the experience stops.
   */
  claim(appSlug: string, experienceSlug: string): () => void {
    const key = keyOf(appSlug, experienceSlug);
    this.claims.set(key, (this.claims.get(key) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = (this.claims.get(key) ?? 1) - 1;
      if (count > 0) this.claims.set(key, count);
      else this.claims.delete(key);
    };
  }

  private apply({ appSlug, experienceSlug, state, startedAs }: RunningExperience): void {
    const key = keyOf(appSlug, experienceSlug);
    if (state === 'idle' || state === 'crashed') {
      this.states.delete(key);
      this.opening.delete(key);
      this.opened.delete(key);
      this.host.closeExperienceWindows(appSlug, experienceSlug);
      return;
    }
    this.states.set(key, state);
    if (state === 'running' && startedAs === 'request') void this.open(appSlug, experienceSlug);
  }

  private async reconcile(): Promise<void> {
    let experiences: readonly RunningExperience[];
    try {
      ({ experiences } = await this.host.server.request('experiences:list'));
    } catch (err) {
      this.log('could not list running experiences', err);
      return;
    }
    const listed = new Set(experiences.map((e) => keyOf(e.appSlug, e.experienceSlug)));
    for (const open of this.host.openExperiences()) {
      const key = keyOf(open.appSlug, open.experienceSlug);
      // Windows opened by others, such as calibration flows, are theirs to close.
      if (listed.has(key) || !this.opened.has(key) || this.opening.has(key)) continue;
      this.states.delete(key);
      this.opened.delete(key);
      this.host.closeExperienceWindows(open.appSlug, open.experienceSlug);
    }
    for (const experience of experiences) this.apply(experience);
  }

  private async open(appSlug: string, experienceSlug: string): Promise<void> {
    const key = keyOf(appSlug, experienceSlug);
    if (this.claims.has(key) || this.opening.has(key) || this.hasWindow(key)) return;
    this.opening.add(key);
    try {
      const { displayId, fullscreen } = await (this.options.resolveDisplay
        ? this.options.resolveDisplay(appSlug)
        : resolveAppDisplay(this.host.server, this.host, appSlug));
      // The experience may have stopped, or been claimed, while the display resolved.
      if (!this.opening.has(key) || this.states.get(key) !== 'running') return;
      if (this.claims.has(key) || this.hasWindow(key)) return;
      this.host.openAppHost({ appSlug, experienceSlug, displayId, fullscreen });
      this.opened.add(key);
    } catch (err) {
      this.log(`could not open a window for ${key}`, err);
    } finally {
      this.opening.delete(key);
    }
  }

  private hasWindow(key: Key): boolean {
    return this.host
      .openExperiences()
      .some((open) => keyOf(open.appSlug, open.experienceSlug) === key);
  }
}
