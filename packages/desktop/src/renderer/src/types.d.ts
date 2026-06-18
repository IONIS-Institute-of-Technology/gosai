// Window type augmentation. The Dashboard and AppHost preloads expose APIs
// here. Declared inline (not imported from preload) so the renderer tsconfig
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
      targetAppSlug?: string;
      driverBinding?: string;
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
  controlWindow: {
    open(args: {
      appSlug: string;
      experienceSlug: string;
      projectorDisplayId?: number;
      targetAppSlug?: string;
      driverBinding?: string;
      width?: number;
      height?: number;
      title?: string;
    }): Promise<{ windowId: number; appSlug: string; experienceSlug: string }>;
    close(windowId: number): Promise<boolean>;
    hide(windowId: number): Promise<boolean>;
    show(windowId: number): Promise<boolean>;
  };
  onExperienceEnded(
    listener: (payload: { appSlug: string; experienceSlug: string }) => void,
  ): () => void;
}

interface AppHostApi {
  version: string;
  platform: string;
}

declare global {
  interface Window {
    readonly gosai?: DashboardApi;
    readonly gosaiApp?: AppHostApi;
  }
}

export {};
