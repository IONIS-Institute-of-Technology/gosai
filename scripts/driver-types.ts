/**
 * Regenerates the built-in driver types and the driver reference from the
 * Python schemas:
 *
 *   packages/sdk/src/drivers.generated.ts
 *   docs/drivers.md
 *
 * `bun run drivers:types` writes both. `bun run drivers:types:check` fails
 * when either differs from what the schemas produce; CI runs it. Needs uv and
 * the Python environment (`bun run python:sync`).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import prettier from 'prettier';
import {
  driverReference,
  driverTypesModule,
  readDriverSchemas,
} from '../packages/sdk/cli/driver-types.js';

const repoRoot = resolve(import.meta.dir, '..');
const typesFile = join(repoRoot, 'packages', 'sdk', 'src', 'drivers.generated.ts');
const docsFile = join(repoRoot, 'docs', 'drivers.md');

const INTRO = `Generated from the Python driver schemas by \`bun run drivers:types\`. Do not edit.

Every driver an app uses is listed in its experience's \`drivers\` in \`gosai.app.json\`.
\`@gosai/sdk\` types these events and actions: \`rt.drivers.on('pose', 'raw_data', (data) => ...)\`
gets \`DriverTypes.pose.RawPosePayload\`, and \`rt.drivers.execute\` checks params and types
results. Apps with their own drivers generate the same types with \`gosai-sdk gen-driver-types\`,
see the [SDK README](../packages/sdk/README.md#driver-data).

**Delivery** says what happens when the app reads events slower than the driver sends them:
\`latest\` keeps only the newest value, \`buffered (n)\` keeps the last n values and
\`ordered\` delivers every value.`;

async function pythonSchemas(): Promise<unknown> {
  const proc = Bun.spawn({
    cmd: ['uv', 'run', '--locked', 'python', '-m', 'gosai_py.schemas'],
    cwd: join(repoRoot, 'python'),
    stdout: 'pipe',
    stderr: 'inherit',
  });
  const [text, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) throw new Error(`python -m gosai_py.schemas exited with ${code}`);
  return JSON.parse(text);
}

async function format(text: string, file: string): Promise<string> {
  const options = await prettier.resolveConfig(file);
  return prettier.format(text, { ...options, filepath: file });
}

const { values } = parseArgs({ options: { check: { type: 'boolean', default: false } } });
const drivers = readDriverSchemas(await pythonSchemas());
const outputs = [
  [typesFile, await format(driverTypesModule(drivers, { kind: 'builtin' }), typesFile)],
  [docsFile, await format(driverReference(drivers, { intro: INTRO }), docsFile)],
] as const;

let stale = 0;
for (const [file, text] of outputs) {
  const name = relative(repoRoot, file);
  if (!values.check) {
    writeFileSync(file, text);
    console.log(`wrote ${name}`);
    continue;
  }
  let current = '';
  try {
    current = readFileSync(file, 'utf8');
  } catch {
    // Missing counts as stale.
  }
  if (current !== text) {
    stale += 1;
    console.error(`${name} is out of date with the Python driver schemas`);
  }
}
if (stale > 0) {
  console.error('Run `bun run drivers:types` and commit the result.');
  process.exit(1);
}
if (values.check) console.log(`driver types and reference match ${drivers.length} driver schemas`);
