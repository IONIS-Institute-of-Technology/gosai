/**
 * Builds the published SDK into `dist/`:
 *
 * - `index.js`, `host.js`, `app-host.js` and their shared chunks: browser ESM
 *   with `@gosai/shared` bundled in. The server serves these to app windows.
 * - `index.d.ts` and `host.d.ts` with the `@gosai/shared` types inlined.
 * - `gosai.app.schema.json`, the manifest JSON Schema.
 *
 * The package has no runtime dependencies, so the build fails when an output
 * still refers to `@gosai/shared` or zod.
 */

import { copyFileSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { rollup } from 'rollup';
import { dts } from 'rollup-plugin-dts';

const packageDir = resolve(import.meta.dir, '..');
const dist = join(packageDir, 'dist');

rmSync(dist, { recursive: true, force: true });

const js = await Bun.build({
  entrypoints: ['index.ts', 'host.ts', 'app-host.ts'].map((file) => join(packageDir, 'src', file)),
  outdir: dist,
  target: 'browser',
  format: 'esm',
  splitting: true,
});
if (!js.success) {
  for (const log of js.logs) console.error(log);
  throw new Error('bundling the SDK failed');
}

const types = await rollup({
  input: { index: join(packageDir, 'src', 'index.ts'), host: join(packageDir, 'src', 'host.ts') },
  // Anything left external would have to be installed next to the SDK.
  external: () => false,
  plugins: [
    dts({
      respectExternal: true,
      tsconfig: join(packageDir, 'tsconfig.json'),
      compilerOptions: { noEmit: false, declaration: true, emitDeclarationOnly: true },
    }),
  ],
  onwarn(warning) {
    throw new Error(`bundling the declarations: ${warning.message}`);
  },
});
await types.write({ dir: dist, format: 'es', chunkFileNames: 'types-[hash].d.ts' });
await types.close();

copyFileSync(
  resolve(packageDir, '..', 'shared', 'schemas', 'gosai.app.schema.json'),
  join(dist, 'gosai.app.schema.json'),
);

const leaks: string[] = [];
for (const file of readdirSync(dist)) {
  if (!file.endsWith('.js') && !file.endsWith('.d.ts')) continue;
  const text = readFileSync(join(dist, file), 'utf8');
  if (/from\s+['"](?:@gosai\/shared|zod)/.test(text) || /import\s+['"]zod/.test(text)) {
    leaks.push(file);
  }
}
if (leaks.length > 0) {
  throw new Error(`these outputs still import @gosai/shared or zod: ${leaks.join(', ')}`);
}

console.log(`built ${readdirSync(dist).length} files into ${dist}`);
