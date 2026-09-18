/**
 * Typing for `rt.drivers`. Payloads, params and results come from
 * `DriverRegistry`, which holds the built-in drivers generated from their
 * Python schemas. A driver missing from the registry still works, with
 * `unknown` data.
 */

import type { BuiltinDrivers } from './drivers.generated.js';

export type { DriverTypes } from './drivers.generated.js';

/**
 * Event and action types of each driver, by driver name. An app that brings
 * its own drivers adds them with `gosai-sdk gen-driver-types`, which writes a
 * module augmentation:
 *
 * ```ts
 * declare module '@gosai/sdk' {
 *   interface DriverRegistry {
 *     my_driver: {
 *       config: undefined;
 *       events: { reading: { value: number } };
 *       actions: { reset: { params: undefined; result: null } };
 *     };
 *   }
 * }
 * ```
 */
export interface DriverRegistry extends BuiltinDrivers {}

/** Names of the drivers in {@link DriverRegistry}. */
export type KnownDriverName = keyof DriverRegistry & string;

/** A driver name. Known names autocomplete, and any other name is accepted. */
export type DriverName = KnownDriverName | (string & {});

/** Event names of a driver: the declared ones for a known driver, any string otherwise. */
export type DriverEvent<D extends string> = D extends KnownDriverName
  ? keyof DriverRegistry[D]['events'] & string
  : string;

/** Action names of a driver: the declared ones for a known driver, any string otherwise. */
export type DriverAction<D extends string> = D extends KnownDriverName
  ? keyof DriverRegistry[D]['actions'] & string
  : string;

/**
 * Data of a driver event. `'*'` is any of the driver's events. `unknown` for
 * drivers and events the registry doesn't know.
 */
export type DriverEventData<D extends string, E extends string> = D extends KnownDriverName
  ? E extends keyof DriverRegistry[D]['events']
    ? DriverRegistry[D]['events'][E]
    : E extends '*'
      ? DriverRegistry[D]['events'][keyof DriverRegistry[D]['events']]
      : unknown
  : unknown;

/** Params of a driver action; `undefined` when it takes none. */
export type DriverActionParams<D extends string, A extends string> = D extends KnownDriverName
  ? A extends keyof DriverRegistry[D]['actions']
    ? DriverRegistry[D]['actions'][A] extends { params: infer P }
      ? P
      : unknown
    : unknown
  : unknown;

/** Result of a driver action. */
export type DriverActionResult<D extends string, A extends string> = D extends KnownDriverName
  ? A extends keyof DriverRegistry[D]['actions']
    ? DriverRegistry[D]['actions'][A] extends { result: infer R }
      ? R
      : unknown
    : unknown
  : unknown;

/**
 * The params argument of `execute`: left out when the action takes none,
 * optional when it accepts `null`. Arrays and objects may be readonly.
 */
export type DriverActionArgs<D extends string, A extends string> =
  DriverActionParams<D, A> extends infer P
    ? [P] extends [undefined]
      ? [params?: undefined]
      : undefined extends P
        ? [params?: ReadonlyDeep<P>]
        : null extends P
          ? [params?: ReadonlyDeep<P>]
          : [params: ReadonlyDeep<P>]
    : never;

/** `T` with every array and property readonly, so callers can pass either. */
type ReadonlyDeep<T> = T extends object ? { readonly [K in keyof T]: ReadonlyDeep<T[K]> } : T;
