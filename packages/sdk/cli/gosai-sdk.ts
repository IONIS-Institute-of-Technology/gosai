#!/usr/bin/env node
/**
 * `gosai-sdk`, the command line tool that ships with `@gosai/sdk`.
 *
 *   gosai-sdk gen-driver-types --schemas <file|-> [--out <file.ts>] [--docs <file.md>]
 *                              [--namespace <Name>] [--module <specifier>]
 *                              [--drivers <a,b>] [--builtin]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { driverReference, driverTypesModule, readDriverSchemas } from './driver-types.js';

const USAGE = `Usage: gosai-sdk gen-driver-types --schemas <file|-> [options]

Writes TypeScript types for rt.drivers from driver schemas, so driver event
payloads and action params and results are typed in your app.

The schemas are the output of \`python -m gosai_py.schemas --app <app dir>\` for
an app's own drivers, of \`python -m gosai_py.schemas\` for the built-in ones, or
the reply to the server's drivers:schema command. Pass - to read them from stdin.

Options:
  --out <file>        Write the types here instead of to stdout.
  --docs <file>       Also write a Markdown reference of the drivers.
  --drivers <a,b>     Only these drivers, for example my-app/counter.
  --namespace <Name>  Namespace that holds the payload types (default AppDriverTypes).
  --module <name>     Module whose DriverRegistry the types extend (default @gosai/sdk).
  --builtin           Write the SDK's own built-in driver file instead.
  -h, --help          Show this help.
`;

function main(argv: readonly string[]): number {
  const [command, ...rest] = argv;
  if (command === undefined || command === '-h' || command === '--help') {
    process.stdout.write(USAGE);
    return command === undefined ? 1 : 0;
  }
  if (command !== 'gen-driver-types') {
    process.stderr.write(`gosai-sdk: unknown command "${command}"\n\n${USAGE}`);
    return 1;
  }
  const { values } = parseArgs({
    args: [...rest],
    options: {
      schemas: { type: 'string' },
      out: { type: 'string' },
      docs: { type: 'string' },
      drivers: { type: 'string' },
      namespace: { type: 'string', default: 'AppDriverTypes' },
      module: { type: 'string', default: '@gosai/sdk' },
      builtin: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (!values.schemas) {
    process.stderr.write(`gosai-sdk: --schemas is required\n\n${USAGE}`);
    return 1;
  }

  const text = readFileSync(values.schemas === '-' ? 0 : values.schemas, 'utf8');
  let drivers = readDriverSchemas(JSON.parse(text));
  if (values.drivers) {
    const wanted = values.drivers.split(',').map((name) => name.trim());
    const missing = wanted.filter((name) => !drivers.some((driver) => driver.name === name));
    if (missing.length > 0) throw new Error(`no schema for ${missing.join(', ')}`);
    drivers = drivers.filter((driver) => wanted.includes(driver.name));
  }

  const types = driverTypesModule(
    drivers,
    values.builtin
      ? { kind: 'builtin' }
      : { kind: 'augment', module: values.module, namespace: values.namespace },
  );
  if (values.out) writeFileSync(values.out, types);
  else process.stdout.write(types);
  if (values.docs) {
    const namespace = values.builtin ? 'DriverTypes' : values.namespace;
    writeFileSync(values.docs, driverReference(drivers, { namespace }));
  }
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`gosai-sdk: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
}
