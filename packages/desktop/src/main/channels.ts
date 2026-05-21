/** Electron IPC channel names. Safe to import from main, preload, and (via
 * preload exposure) renderer code.
 */

export const IPC_CHANNELS = {
  Displays: 'gosai:displays',
  AppHostOpen: 'gosai:app-host:open',
  AppHostClose: 'gosai:app-host:close',
  AppHostList: 'gosai:app-host:list',

  ControlWindowOpen: 'gosai:control-window:open',
  ControlWindowClose: 'gosai:control-window:close',
  ControlWindowHide: 'gosai:control-window:hide',
  ControlWindowShow: 'gosai:control-window:show',

  ExperienceEnd: 'gosai:experience:end',
  ExperienceEnded: 'gosai:experience:ended',
} as const;
