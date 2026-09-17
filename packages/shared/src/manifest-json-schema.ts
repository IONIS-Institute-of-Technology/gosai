import { z } from 'zod';
import { appManifestSchema } from './schemas.js';

/** The manifest's JSON Schema, formatted as it is committed. */
export function manifestJsonSchema(): string {
  const schema = z.toJSONSchema(appManifestSchema, { io: 'input', unrepresentable: 'any' });
  return `${JSON.stringify({ ...schema, title: 'GOSAI app manifest (gosai.app.json)' }, null, 2)}\n`;
}
