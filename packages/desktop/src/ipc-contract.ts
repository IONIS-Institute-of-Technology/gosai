/**
 * The IPC contract between Electron main and the dashboard. Types only, so
 * main, the preload script and the renderer all import it without pulling in
 * each other's code.
 *
 * Every channel is for the dashboard window only. The dashboard talks to the
 * server itself; IPC covers what only main can do: list displays, report the
 * windows it opened, and run a calibration flow.
 */

import type { DisplayInfo } from '@gosai/shared';
import type { CalibrationResult } from '@gosai/shared/calibration';

export interface DisplayList {
  readonly displays: readonly DisplayInfo[];
  readonly primary: DisplayInfo;
}

/** A window main opened for an experience. */
export interface AppWindowInfo {
  readonly windowId: number;
  readonly appSlug: string;
  readonly experienceSlug: string;
  /** `app` for the fullscreen host window, `control` for a calibration control window. */
  readonly role: 'app' | 'control';
  /** Display an app window was opened on. `null` for control windows. */
  readonly displayId: number | null;
}

export interface CalibrationRunArgs {
  readonly appSlug: string;
  /** Display of the projector window. Defaults to the app's display assignment. */
  readonly displayId?: number;
}

/** Channels the dashboard invokes, with their arguments and what they resolve with. */
export interface IpcInvokeChannels {
  'gosai:displays:list': { readonly args: []; readonly result: DisplayList };
  'gosai:windows:list': { readonly args: []; readonly result: readonly AppWindowInfo[] };
  /** Resolves when the flow ends. Main opens and closes its windows. */
  'gosai:calibration:run': {
    readonly args: [CalibrationRunArgs];
    readonly result: CalibrationResult;
  };
}

/** Channels main sends to the dashboard, with their payload. */
export interface IpcEventChannels {
  /** The windows main has open changed. Carries the full list. */
  'gosai:windows-changed': readonly AppWindowInfo[];
  /** A display was added, removed or changed. */
  'gosai:displays-changed': DisplayList;
}

export type IpcInvokeChannel = keyof IpcInvokeChannels;
export type IpcEventChannel = keyof IpcEventChannels;
export type IpcArgs<C extends IpcInvokeChannel> = IpcInvokeChannels[C]['args'];
export type IpcResult<C extends IpcInvokeChannel> = IpcInvokeChannels[C]['result'];

/** What the preload script exposes to the dashboard as `window.gosai`. */
export interface DashboardApi {
  readonly version: string;
  readonly platform: string;
  readonly displays: {
    list(): Promise<DisplayList>;
    onChanged(listener: (displays: DisplayList) => void): () => void;
  };
  readonly windows: {
    list(): Promise<readonly AppWindowInfo[]>;
    onChanged(listener: (windows: readonly AppWindowInfo[]) => void): () => void;
  };
  readonly calibration: {
    run(args: CalibrationRunArgs): Promise<CalibrationResult>;
  };
}
