import type { CalibrationResult } from '@gosai/shared/calibration';

// Window type augmentation. The dashboard preload exposes its API here. Declared inline (not imported from preload) so the renderer tsconfig
// does not need to compile main/preload sources.

interface DisplayBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface DashboardDisplay {
  id: number;
  label: string;
  bounds: DisplayBounds;
  workArea: DisplayBounds;
  scaleFactor: number;
  primary: boolean;
  internal: boolean;
}

interface DashboardApi {
  version: string;
  platform: string;
  displays: {
    list(): Promise<{ displays: DashboardDisplay[]; primary: DashboardDisplay }>;
  };
  appHost: {
    open(args: {
      displayId: number;
      appSlug: string;
      experienceSlug: string;
      fullscreen?: boolean;
    }): Promise<{
      windowId: number;
      displayId: number;
      appSlug: string;
      experienceSlug: string;
    }>;
    close(windowId: number): Promise<boolean>;
    list(): Promise<
      Array<{ windowId: number; appSlug: string; experienceSlug: string; displayId: number }>
    >;
  };
  experience: {
    end(args: { appSlug: string; experienceSlug: string }): Promise<{ ok: true }>;
  };
  calibration: {
    /** Runs the app's calibration flow; resolves when it ends. */
    run(args: { appSlug: string; displayId?: number }): Promise<CalibrationResult>;
  };
  onExperienceEnded(
    listener: (payload: { appSlug: string; experienceSlug: string }) => void,
  ): () => void;
}

declare global {
  interface Window {
    readonly gosai?: DashboardApi;
  }
}

export {};
