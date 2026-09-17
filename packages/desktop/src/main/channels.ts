/** Electron IPC channel names. Safe to import from main, preload, and (via
 * preload exposure) renderer code.
 */

export const IPC_CHANNELS = {
  Displays: 'gosai:displays',
  AppHostOpen: 'gosai:app-host:open',
  AppHostClose: 'gosai:app-host:close',
  AppHostList: 'gosai:app-host:list',

  CalibrationRun: 'gosai:calibration:run',

  ExperienceEnd: 'gosai:experience:end',
  ExperienceEnded: 'gosai:experience:ended',
} as const;
