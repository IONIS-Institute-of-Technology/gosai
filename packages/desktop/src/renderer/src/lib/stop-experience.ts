import type { RunningExperience } from '@gosai/shared';
import type { ServerClient } from './server-client.js';

/** Stop an experience on the server and close all of its desktop windows. */
export async function stopExperienceFully(
  client: ServerClient,
  appSlug: string,
  experienceSlug: string,
): Promise<void> {
  const api = window.gosai;
  if (api?.experience?.end) {
    await api.experience.end({ appSlug, experienceSlug });
    return;
  }
  await client.request('experience:stop', { appSlug, experienceSlug });
}

/** Stop every running experience for an app and close all related windows. */
export async function stopAllAppExperiences(
  client: ServerClient,
  appSlug: string,
  running: RunningExperience[],
): Promise<void> {
  const forApp = running.filter((r) => r.appSlug === appSlug);
  await Promise.all(forApp.map((r) => stopExperienceFully(client, r.appSlug, r.experienceSlug)));
}
