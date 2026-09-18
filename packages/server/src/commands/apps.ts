import { appEventName } from '@gosai/shared/events';
import type { CommandHandlers } from '../ipc/gateway.js';
import type { ServerServices } from './context.js';

type AppCommands = Pick<
  CommandHandlers,
  | 'apps:list'
  | 'app:install'
  | 'app:uninstall'
  | 'app:capabilities:set'
  | 'app:broadcast'
  | 'app:log'
  | 'app:settings:get'
  | 'app:settings:set'
  | 'experiences:list'
  | 'experience:start'
  | 'experience:stop'
  | 'storage:get'
  | 'storage:set'
  | 'storage:remove'
  | 'storage:list'
  | 'calibration:get'
  | 'calibration:save'
>;

export function appCommands({
  apps,
  settings,
  storage,
  calibration,
  logger,
  bus,
}: ServerServices): AppCommands {
  const requireApp = (slug: string): void => {
    if (!apps.getManifest(slug)) throw new Error(`App not installed: ${slug}`);
  };

  return {
    'apps:list': () => ({ apps: apps.listApps(), invalid: apps.listInvalidApps() }),
    'app:install': ({ source, capabilities, reuseData }) =>
      apps.installFromGit(source, {
        ...(capabilities ? { capabilities } : {}),
        ...(reuseData !== undefined ? { reuseData } : {}),
      }),
    'app:capabilities:set': ({ appSlug, capabilities }) =>
      apps.approveCapabilities(appSlug, capabilities),
    'app:uninstall': async ({ slug, deleteData }) => ({
      slug,
      dataDeleted: await apps.uninstall(slug, deleteData === undefined ? {} : { deleteData }),
    }),

    // App-scoped pub/sub for multi-window experiences (a projector and a
    // control window, say). Every other client subscribed to
    // `app:<slug>:<topic>` receives it; the sender doesn't.
    'app:broadcast': ({ appSlug, topic, data }, ctx) => {
      bus.emit(appEventName(appSlug, topic), data ?? null, `app:${appSlug}`, ctx.clientId);
      return { ok: true };
    },

    // Apps log through the central logger so the dashboard shows them inline.
    'app:log': ({ source, level, message, data }) => {
      logger.log(source, level ?? 'info', message, data ?? undefined);
      return { ok: true };
    },

    'app:settings:get': ({ appSlug }) => settings.get(appSlug),
    'app:settings:set': ({ appSlug, values }, ctx) => settings.set(appSlug, values, ctx.clientId),

    'experiences:list': () => ({ experiences: apps.listRunningExperiences() }),
    'experience:start': ({ appSlug, experienceSlug, driverBinding }) =>
      apps.startExperience(
        appSlug,
        experienceSlug,
        driverBinding === undefined ? {} : { driverBinding },
      ),
    'experience:stop': async ({ appSlug, experienceSlug, error }) => {
      await apps.stopExperience(appSlug, experienceSlug, error === undefined ? {} : { error });
      return { ok: true };
    },

    'storage:get': ({ appSlug, key }) => {
      requireApp(appSlug);
      return storage.get(appSlug, key);
    },
    'storage:set': ({ appSlug, key, value }) => {
      requireApp(appSlug);
      storage.set(appSlug, key, value);
      return { ok: true };
    },
    'storage:remove': ({ appSlug, key }) => {
      requireApp(appSlug);
      return { removed: storage.remove(appSlug, key) };
    },
    'storage:list': ({ appSlug }) => {
      requireApp(appSlug);
      return { keys: storage.list(appSlug) };
    },

    'calibration:get': ({ appSlug }) => calibration.get(appSlug),
    'calibration:save': ({ appSlug, profile }) => ({ profile: calibration.save(appSlug, profile) }),
  };
}
