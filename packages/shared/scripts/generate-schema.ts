/**
 * Writes `schemas/gosai.app.schema.json` from the manifest's zod schema.
 * `bun run generate:schema` after changing the schema; a test fails when the
 * committed file is out of date.
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { manifestJsonSchema } from '../src/manifest-json-schema.js';

const target = resolve(import.meta.dir, '..', 'schemas', 'gosai.app.schema.json');
writeFileSync(target, manifestJsonSchema());
console.log(`wrote ${target}`);
