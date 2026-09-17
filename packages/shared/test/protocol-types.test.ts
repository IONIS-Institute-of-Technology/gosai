import { expect, test } from 'bun:test';
import type { z } from 'zod';
import type { commandSchemas, eventSchemas } from '../src/protocol-schemas.js';
import type {
  CommandRequests,
  CommandResponses,
  FixedEventPayloadMap,
  ParsedCommandRequests,
} from '../src/protocol-types.js';

/**
 * `src/protocol-types.ts` is generated from the zod schemas. These checks
 * fail to type-check when it is stale: run
 * `bun run --filter @gosai/shared generate:protocol-types`.
 */
type Same<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

type Commands = typeof commandSchemas;
type Events = typeof eventSchemas;

type Checks = {
  requests: { [C in keyof Commands]: Same<CommandRequests[C], z.input<Commands[C]['request']>> };
  parsed: {
    [C in keyof Commands]: Same<ParsedCommandRequests[C], z.output<Commands[C]['request']>>;
  };
  responses: {
    [C in keyof Commands]: Same<CommandResponses[C], z.output<Commands[C]['response']>>;
  };
  events: { [E in keyof Events]: Same<FixedEventPayloadMap[E], z.output<Events[E]>> };
  commandNames: Same<keyof CommandRequests, keyof Commands>;
  eventNames: Same<keyof FixedEventPayloadMap, keyof Events>;
};

/** `T` with every leaf replaced by `true`; `Checks` only extends it when every check passed. */
type AllTrue<T> = T extends boolean ? true : { [K in keyof T]: AllTrue<T[K]> };

const checks: Checks extends AllTrue<Checks> ? true : false = true;

test('the generated protocol types match the zod schemas', () => {
  expect(checks).toBe(true);
});
