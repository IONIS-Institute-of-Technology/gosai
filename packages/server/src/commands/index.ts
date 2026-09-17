import type { CommandHandlers } from '../ipc/gateway.js';
import { appCommands } from './apps.js';
import type { ServerServices } from './context.js';
import { systemCommands } from './system.js';

export type { ServerServices } from './context.js';

/** Every command handler. The gateway validates payloads and capabilities first. */
export function createCommandHandlers(services: ServerServices): CommandHandlers {
  return { ...appCommands(services), ...systemCommands(services) };
}
