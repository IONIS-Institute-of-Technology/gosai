import { SYSTEM_BINDING } from '@gosai/shared/commands';
import { applyAppDeviceSettings, applyGlobalCameraSettings } from '../drivers/camera-config.js';
import type { CommandHandlers } from '../ipc/gateway.js';
import { levelAtLeast } from '../logger/logger.js';
import type { ServerServices } from './context.js';

type SystemCommands = Pick<
  CommandHandlers,
  | 'system:ping'
  | 'logs:history'
  | 'config:get'
  | 'config:set'
  | 'app:config:get'
  | 'app:config:set'
  | 'drivers:list'
  | 'devices:list'
  | 'driver:get-data'
  | 'driver:execute'
  | 'driver:subscribe'
  | 'driver:unsubscribe'
>;

export function systemCommands(services: ServerServices): SystemCommands {
  const { apps, drivers, config, deviceSettings, logger } = services;
  const sources = { config, appSettings: deviceSettings };
  const binding = (value: string | undefined): string => value ?? SYSTEM_BINDING;

  return {
    'system:ping': () => ({ ts: Date.now() }),

    'logs:history': ({ limit, level }) => {
      const logs = logger.history().filter((entry) => !level || levelAtLeast(entry.level, level));
      return { logs: limit === undefined ? logs : logs.slice(-limit) };
    },

    'config:get': () => config.get(),
    'config:set': async (patch) => {
      const previousCamera = config.get().camera;
      const next = config.update(patch);
      await applyGlobalCameraSettings(drivers, sources, previousCamera, logger.child('camera'));
      return next;
    },

    'app:config:get': ({ appSlug }) => deviceSettings.get(appSlug),
    'app:config:set': async ({ appSlug, settings }) => {
      if (!apps.getManifest(appSlug)) throw new Error(`App not installed: ${appSlug}`);
      const previous = deviceSettings.get(appSlug);
      const next = deviceSettings.update(appSlug, settings);
      await applyAppDeviceSettings(drivers, sources, appSlug, previous, logger.child('app-config'));
      return next;
    },

    'drivers:list': () => ({ drivers: drivers.listDrivers() }),
    'devices:list': () => drivers.listDevices(),
    'driver:get-data': (p) => drivers.getData(binding(p.binding), p.driver, p.event),
    'driver:execute': (p) => drivers.execute(binding(p.binding), p.driver, p.action, p.data),
    'driver:subscribe': async (p, ctx) => {
      await drivers.subscribe(binding(p.binding), p.driver, p.event, ctx.clientId);
      return { ok: true };
    },
    'driver:unsubscribe': async (p, ctx) => {
      await drivers.unsubscribe(binding(p.binding), p.driver, p.event, ctx.clientId);
      return { ok: true };
    },
  };
}
