/**
 * Checks `@gosai/sdk` the way an app outside this repository gets it:
 *
 * 1. builds the SDK and packs it with `bun pm pack`,
 * 2. checks the tarball: no dependencies, and a version inside the
 *    template's `@gosai/sdk` range,
 * 3. copies `templates/basic` to a temporary directory, points its
 *    `@gosai/sdk` dependency at the tarball and installs it,
 * 4. generates types for an app driver with the packed `gosai-sdk` command,
 * 5. type-checks the template, together with a file that uses the typed
 *    built-in drivers, the generated driver and the host entry, and builds it.
 *
 *   bun run sdk:check-package [--keep]
 *
 * `--keep` leaves the temporary directory for inspection. Installing the
 * template's other dev dependencies needs the npm registry.
 */

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const repoRoot = resolve(import.meta.dir, '..');
const sdkDir = join(repoRoot, 'packages', 'sdk');
const templateDir = join(repoRoot, 'templates', 'basic');

const { values } = parseArgs({ options: { keep: { type: 'boolean', default: false } } });

async function run(cmd: string[], cwd: string): Promise<string> {
  console.log(`\n$ ${cmd.join(' ')}   (in ${cwd})`);
  const proc = Bun.spawn({ cmd, cwd, stdout: 'pipe', stderr: 'inherit' });
  const [output, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  process.stdout.write(output);
  if (code !== 0) throw new Error(`${cmd.join(' ')} exited with ${code}`);
  return output;
}

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
  console.log(`ok: ${message}`);
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

interface PackageJson {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const work = mkdtempSync(join(tmpdir(), 'gosai-sdk-package-'));
let failed = false;
try {
  await run([process.execPath, 'run', 'build'], sdkDir);
  await run([process.execPath, 'pm', 'pack', '--destination', work], sdkDir);
  const sdkPackage = readJson<PackageJson>(join(sdkDir, 'package.json'));
  const tarball = join(work, `gosai-sdk-${sdkPackage.version}.tgz`);

  const unpacked = join(work, 'unpacked');
  await run(['mkdir', '-p', unpacked], work);
  await run(['tar', '-xzf', tarball, '-C', unpacked], work);
  const packed = readJson<PackageJson>(join(unpacked, 'package', 'package.json'));
  check(
    Object.keys({ ...packed.dependencies, ...packed.peerDependencies }).length === 0,
    'the packed SDK has no runtime or peer dependencies',
  );
  for (const file of ['index.js', 'index.d.ts', 'host.js', 'host.d.ts', 'gosai.app.schema.json']) {
    check(
      Bun.file(join(unpacked, 'package', 'dist', file)).size > 0,
      `the packed SDK has dist/${file}`,
    );
  }
  const template = readJson<PackageJson>(join(templateDir, 'package.json'));
  const range = template.dependencies?.['@gosai/sdk'] ?? '';
  check(
    Bun.semver.satisfies(packed.version, range) && !range.startsWith('workspace:'),
    `the template's @gosai/sdk range ${range} includes the packed ${packed.version}`,
  );

  const app = join(work, 'app');
  cpSync(templateDir, app, {
    recursive: true,
    filter: (source) => !/[/\\](node_modules|dist)([/\\]|$)/.test(source.slice(templateDir.length)),
  });
  const appPackage = readJson<PackageJson>(join(app, 'package.json'));
  writeFileSync(
    join(app, 'package.json'),
    `${JSON.stringify(
      {
        ...appPackage,
        dependencies: { ...appPackage.dependencies, '@gosai/sdk': `file:${tarball}` },
      },
      null,
      2,
    )}\n`,
  );
  await run([process.execPath, 'install'], app);

  // An app driver's schema, as `python -m gosai_py.schemas` prints it.
  writeFileSync(
    join(work, 'schemas.json'),
    JSON.stringify({
      drivers: [
        {
          name: 'thermometer',
          description: 'A test driver.',
          schema: {
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            config: null,
            events: {
              reading: {
                description: 'Latest reading.',
                delivery: 'latest',
                payload: { $ref: '#/$defs/Reading' },
              },
            },
            actions: {
              calibrate: {
                description: 'Set the offset.',
                params: { type: 'number' },
                result: { $ref: '#/$defs/Reading' },
                requires_instance: true,
              },
            },
            $defs: {
              Reading: {
                type: 'object',
                properties: { celsius: { type: 'number' } },
                required: ['celsius'],
              },
            },
          },
        },
      ],
    }),
  );
  await run(
    [
      join(app, 'node_modules', '.bin', 'gosai-sdk'),
      'gen-driver-types',
      '--schemas',
      join(work, 'schemas.json'),
      '--out',
      join(app, 'src', 'driver-types.ts'),
    ],
    app,
  );
  writeFileSync(
    join(app, 'src', 'package-check.ts'),
    `import { defineExperience, SDK_VERSION, type DriverTypes } from '@gosai/sdk';
import { PROTOCOL_VERSION, ServerClient, type RuntimeOptions } from '@gosai/sdk/host';
import type { AppDriverTypes } from './driver-types.js';

export const versions: [string, number] = [SDK_VERSION, PROTOCOL_VERSION];
export const client: ServerClient | null = null;
export const options: Partial<RuntimeOptions> = { maxDeltaMs: 50 };

export default defineExperience({
  async start(rt) {
    rt.drivers.on('pose', 'raw_data', (data: DriverTypes.pose.RawPosePayload) => data.body_pose);
    rt.drivers.on('thermometer', 'reading', (data) => {
      const celsius: number = data.celsius;
      return celsius;
    });
    const reading: AppDriverTypes.thermometer.Reading = await rt.drivers.execute(
      'thermometer',
      'calibrate',
      0.5,
    );
    // @ts-expect-error: calibrate takes a number
    await rt.drivers.execute('thermometer', 'calibrate', 'hot');
    // @ts-expect-error: pose has no such event
    rt.drivers.on('pose', 'no_such_event', () => undefined);
    rt.drivers.on('someone_elses_driver', 'event', (data: unknown) => data);
    rt.log.info('reading', { celsius: reading.celsius });
    await rt.app.server.request('system:ping');
  },
});
`,
  );
  await run([process.execPath, 'run', 'typecheck'], app);
  // The template skips library checks; the SDK's declarations must pass them too.
  await run([join(app, 'node_modules', '.bin', 'tsc'), '--skipLibCheck', 'false'], app);
  await run([process.execPath, 'run', 'build'], app);
  const bundle = readFileSync(join(app, 'dist', 'main.js'), 'utf8');
  check(
    /from\s*["']@gosai\/sdk["']/.test(bundle) && !bundle.includes('class ServerClient'),
    'the template build keeps @gosai/sdk external',
  );
  console.log(
    `\n@gosai/sdk ${packed.version} packs, installs and builds the template in isolation`,
  );
} catch (err) {
  failed = true;
  console.error(`\nsdk:check-package failed: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  if (values.keep || failed) console.log(`files kept in ${work}`);
  else rmSync(work, { recursive: true, force: true });
}
if (failed) process.exit(1);
