import { splitDriverName, type DriverInfo } from '@gosai/shared';

export interface DriverGroup {
  /** The app that ships the drivers, or `null` for GOSAI's built-in drivers. */
  readonly app: string | null;
  readonly drivers: readonly DriverInfo[];
}

/**
 * Built-in drivers first, then each app's drivers (named `<slug>/<driver>`)
 * under their app, apps in alphabetical order.
 */
export function groupDrivers(drivers: readonly DriverInfo[]): DriverGroup[] {
  const groups = new Map<string | null, DriverInfo[]>();
  for (const driver of drivers) {
    const { app } = splitDriverName(driver.name);
    let group = groups.get(app);
    if (!group) groups.set(app, (group = []));
    group.push(driver);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === null ? -1 : b === null ? 1 : a.localeCompare(b)))
    .map(([app, list]) => ({ app, drivers: list }));
}
