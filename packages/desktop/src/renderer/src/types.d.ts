import type { DashboardApi } from '../../ipc-contract.js';

declare global {
  interface Window {
    /** Exposed by the dashboard preload script, which always runs. */
    readonly gosai: DashboardApi;
  }
}

export {};
