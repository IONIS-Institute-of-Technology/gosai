/**
 * Driver names. Built-in drivers have plain names such as `hand_pose`. Drivers
 * an app ships (the manifest's `python` field) are named `<app slug>/<driver>`,
 * such as `hello-gosai/counter`, so they can't collide with built-in drivers or
 * with another app's.
 */

/** A built-in driver name, or the part of an app driver name after the slash. */
export const DRIVER_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

/** `<app slug>/<driver>`. */
export const APP_DRIVER_NAME_PATTERN = /^[a-z][a-z0-9-]*\/[a-z][a-z0-9_]*$/;

/** Whether `value` names a built-in driver or an app's driver. */
export function isDriverName(value: string): boolean {
  return DRIVER_NAME_PATTERN.test(value) || APP_DRIVER_NAME_PATTERN.test(value);
}

/** The name the server gives driver `driver` of app `appSlug`. */
export function appDriverName(appSlug: string, driver: string): string {
  return `${appSlug}/${driver}`;
}

/**
 * Splits a driver name into the app that ships it and the name inside that
 * app's bridge. `app` is `null` for a built-in driver.
 */
export function splitDriverName(name: string): { app: string | null; driver: string } {
  const slash = name.indexOf('/');
  if (slash === -1) return { app: null, driver: name };
  return { app: name.slice(0, slash), driver: name.slice(slash + 1) };
}
