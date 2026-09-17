/**
 * WebSocket message protocol shared between server, desktop, and apps.
 *
 * Every message is a JSON envelope. Clients send commands, each with an `id`;
 * the server answers with a `response` envelope carrying that id, and pushes
 * events the client subscribed to. The shapes come from the zod schemas in
 * `protocol-schemas.ts`, expanded into plain types in `protocol-types.ts`, so
 * neither browser bundles nor published declarations need zod.
 */

import type { AppEventName, DriverEventName, FixedServerEventName } from './events.js';
import type {
  CommandRequests,
  CommandResponses,
  FixedEventPayloadMap,
  ParsedCommandRequests,
} from './protocol-types.js';
import type { DriverEventPayload, DriverRuntimeInfo } from './types.js';

export const PROTOCOL_VERSION = 1;

export interface MessageEnvelope<TType extends string = string, TPayload = unknown> {
  readonly v: typeof PROTOCOL_VERSION;
  readonly id?: string;
  readonly type: TType;
  readonly payload: TPayload;
  readonly ts?: number;
}

export const ErrorCodes = {
  InvalidJson: 'INVALID_JSON',
  InvalidMessage: 'INVALID_MESSAGE',
  UnsupportedVersion: 'UNSUPPORTED_VERSION',
  UnknownCommand: 'UNKNOWN_COMMAND',
  InvalidPayload: 'INVALID_PAYLOAD',
  Forbidden: 'FORBIDDEN',
  HandlerError: 'HANDLER_ERROR',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export interface ErrorPayload {
  readonly code: ErrorCode;
  readonly message: string;
  readonly details?: unknown;
}

export type CommandName = keyof CommandRequests;

/** What a client sends. Fields with defaults may be left out. */
export type CommandRequest<C extends CommandName> = CommandRequests[C];

/** What the server hands the command handler, after validation. */
export type ParsedCommandRequest<C extends CommandName> = ParsedCommandRequests[C];

export type CommandResponse<C extends CommandName> = CommandResponses[C];

export type FixedEventPayloads = { [E in FixedServerEventName]: FixedEventPayloadMap[E] };

/** Payload type of any event name, including `driver:event:<binding>` and app events. */
export type EventPayload<E extends string> = E extends FixedServerEventName
  ? FixedEventPayloads[E]
  : E extends DriverEventName
    ? DriverEventPayload
    : E extends AppEventName
      ? unknown
      : unknown;

export type WelcomePayload = FixedEventPayloads['server:welcome'];

export type ResponsePayload =
  | { readonly requestId: string; readonly ok: true; readonly data: unknown }
  | { readonly requestId: string; readonly ok: false; readonly error: ErrorPayload };

/**
 * Python <-> Server bridge protocol (stdio newline-delimited JSON).
 *
 * Every `ts` is milliseconds since the Unix epoch. Bump
 * {@link BRIDGE_PROTOCOL_VERSION} together with `PROTOCOL_VERSION` in
 * `python/src/gosai_py/bridge.py` whenever these shapes change.
 */
export const BRIDGE_PROTOCOL_VERSION = 2;

export type BridgeRequest =
  | { type: 'ping'; id: string }
  | { type: 'list-drivers'; id: string }
  | { type: 'list-instances'; id: string }
  | { type: 'list-cameras'; id: string }
  | { type: 'list-audio-devices'; id: string }
  | {
      type: 'start-driver';
      id: string;
      instance: string;
      driver: string;
      config?: Record<string, unknown>;
    }
  | { type: 'stop-driver'; id: string; instance: string; driver: string }
  | { type: 'subscribe'; id: string; instance: string; driver: string; event: string }
  | { type: 'unsubscribe'; id: string; instance: string; driver: string; event: string }
  | { type: 'get-data'; id: string; instance: string; driver: string; event: string }
  | {
      type: 'execute';
      id: string;
      instance: string;
      driver: string;
      action: string;
      data?: unknown;
    }
  | { type: 'shutdown'; id: string };

export type BridgeResponse =
  | { type: 'pong'; id: string; ts: number }
  | { type: 'result'; id: string; ok: true; data?: unknown }
  | { type: 'result'; id: string; ok: false; error: string }
  | { type: 'event'; instance: string; driver: string; event: string; data: unknown; ts: number }
  | { type: 'log'; level: string; source: string; instance?: string; message: string; ts: number }
  | {
      type: 'driver-state';
      instance: string;
      driver: string;
      state: string;
      runtime?: DriverRuntimeInfo;
    }
  | {
      /** Summary of one metric over the last second: `value` is the mean. */
      type: 'performance';
      instance: string;
      source: string;
      metric: string;
      value: number;
      max: number;
      count: number;
      ts: number;
    }
  | { type: 'ready'; version: string; protocol: number };

/** Reply to `list-instances`: what the bridge is actually running. */
export interface BridgeInstanceList {
  readonly instances: readonly {
    readonly instance: string;
    readonly driver: string;
    readonly state: string;
    readonly subscriptions: readonly string[];
  }[];
}
