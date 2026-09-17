/**
 * Installing an app and approving what it asks for.
 *
 * The server only reads a manifest once it has cloned the app, so the
 * dashboard installs first, with nothing granted, and then asks the operator
 * which of the requested capabilities to approve. An app holds none of them
 * until the operator approves; closing the prompt approves none.
 */

import {
  CAPABILITY_INFO,
  type Capability,
  type CommandRequest,
  type InstalledApp,
} from '@gosai/shared';
import { ServerRequestError, type ServerClient } from '@gosai/shared/client';

export type InstallClient = Pick<ServerClient, 'request'>;

/** The server refused to reuse data an app with the same slug left from another source. */
export function isAppDataConflict(err: unknown): err is ServerRequestError {
  return (
    err instanceof ServerRequestError &&
    (err.details as { reason?: unknown } | undefined)?.reason === 'app-data-conflict'
  );
}

/**
 * Installs the app with no capability granted. When the server finds data
 * from an earlier app with the same slug, `confirmReuseData` decides whether
 * to install anyway and keep it. Resolves with `null` when it declines.
 */
export async function installApp(
  client: InstallClient,
  source: string,
  confirmReuseData: (message: string) => Promise<boolean>,
): Promise<InstalledApp | null> {
  const request: CommandRequest<'app:install'> = { source, capabilities: [] };
  try {
    return await client.request('app:install', request);
  } catch (err) {
    if (!isAppDataConflict(err)) throw err;
    if (!(await confirmReuseData(err.message))) return null;
    return client.request('app:install', { ...request, reuseData: true });
  }
}

export interface CapabilityChoice {
  readonly capability: Capability;
  readonly description: string;
  readonly granted: boolean;
}

/** The capabilities the app requests, with their description and whether it holds them. */
export function capabilityChoices(app: InstalledApp): CapabilityChoice[] {
  const granted = new Set(app.grantedCapabilities);
  return (app.manifest.capabilities ?? []).map((capability) => ({
    capability,
    description: CAPABILITY_INFO[capability].description,
    granted: granted.has(capability),
  }));
}

/**
 * The `@gosai/sdk` versions the app says it works with. The server refuses to
 * install, and lists as invalid, an app whose range excludes its SDK.
 */
export function sdkRangeLabel(manifest: Pick<InstalledApp['manifest'], 'sdk'>): string {
  return manifest.sdk === undefined ? 'no SDK range declared' : `SDK ${manifest.sdk}`;
}

/** Whether the app asks for anything an operator should review. */
export function hasPermissionRequests(app: InstalledApp): boolean {
  return (
    (app.manifest.capabilities?.length ?? 0) > 0 ||
    (app.manifest.network?.connect?.length ?? 0) > 0 ||
    app.manifest.python !== undefined
  );
}

/** Records which requested capabilities the operator approved. Others are revoked. */
export function saveCapabilityGrants(
  client: InstallClient,
  app: InstalledApp,
  approved: ReadonlySet<Capability>,
): Promise<InstalledApp> {
  const capabilities = (app.manifest.capabilities ?? []).filter((c) => approved.has(c));
  return client.request('app:capabilities:set', { appSlug: app.manifest.slug, capabilities });
}
