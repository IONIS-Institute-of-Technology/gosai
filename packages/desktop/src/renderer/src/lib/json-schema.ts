/**
 * Turns the JSON Schemas of a driver's config, events and actions into a tree
 * the Drivers panel can show. `$ref`s resolve against the driver's own schema
 * root, since `$defs` names repeat across drivers with different contents.
 */

import type { JsonSchema } from '@gosai/shared';

export interface SchemaNode {
  /** A short type, such as `number ≥ 0`, `string[]` or `BallsPayload`. */
  readonly type: string;
  readonly description?: string;
  /** The default value as JSON. */
  readonly default?: string;
  /** Object properties, including those of array items and referenced definitions. */
  readonly fields?: readonly SchemaField[];
}

export interface SchemaField {
  readonly name: string;
  readonly required: boolean;
  readonly node: SchemaNode;
}

const MAX_DEPTH = 6;

export function describeSchema(schema: JsonSchema | null | undefined, root: object): SchemaNode {
  if (!schema) return { type: 'none' };
  return describe(schema, root, [], 0);
}

function describe(
  schema: JsonSchema,
  root: object,
  refs: readonly string[],
  depth: number,
): SchemaNode {
  const description = typeof schema.description === 'string' ? schema.description : undefined;
  const fallback = 'default' in schema ? JSON.stringify(schema.default) : undefined;
  const annotate = (node: SchemaNode): SchemaNode => ({
    ...node,
    ...(description && !node.description ? { description } : {}),
    ...(fallback !== undefined && node.default === undefined ? { default: fallback } : {}),
  });

  const ref = schema.$ref;
  if (typeof ref === 'string') {
    const name = ref.split('/').at(-1) ?? ref;
    const target = resolveRef(root, ref);
    if (!target) return annotate({ type: `${name} (unresolved)` });
    // A recursive definition shows its name only the second time.
    if (refs.includes(ref) || depth >= MAX_DEPTH) return annotate({ type: name });
    const resolved = describe(target, root, [...refs, ref], depth + 1);
    const type = resolved.fields ? name : resolved.type;
    return annotate({ ...resolved, type });
  }

  const variants = (schema.anyOf ?? schema.oneOf) as JsonSchema[] | undefined;
  if (Array.isArray(variants)) {
    const nodes = variants.map((v) => describe(v, root, refs, depth + 1));
    const withFields = nodes.filter((n) => n.fields);
    return annotate({
      type: unique(nodes.map((n) => n.type)).join(' | '),
      ...(withFields.length === 1 ? { fields: withFields[0]!.fields } : {}),
    });
  }

  if ('const' in schema) return annotate({ type: JSON.stringify(schema.const) });
  if (Array.isArray(schema.enum)) {
    return annotate({ type: schema.enum.map((v) => JSON.stringify(v)).join(' | ') });
  }

  const types = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type];
  const nonNull = types.filter((t): t is string => typeof t === 'string' && t !== 'null');
  const nullable = types.includes('null') ? ' | null' : '';

  if (nonNull.includes('array') || schema.items !== undefined || schema.prefixItems !== undefined) {
    if (Array.isArray(schema.prefixItems)) {
      const items = (schema.prefixItems as JsonSchema[]).map(
        (item) => describe(item, root, refs, depth + 1).type,
      );
      return annotate({ type: `[${items.join(', ')}]${nullable}` });
    }
    const item =
      schema.items && typeof schema.items === 'object'
        ? describe(schema.items as JsonSchema, root, refs, depth + 1)
        : { type: 'unknown' };
    const itemType = item.type.includes(' ') ? `(${item.type})` : item.type;
    return annotate({
      type: `${itemType}[]${bounds(schema, 'minItems', 'maxItems', ' items')}${nullable}`,
      ...(item.fields ? { fields: item.fields } : {}),
    });
  }

  if (nonNull.includes('object') || schema.properties !== undefined) {
    const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
    const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
    const fields = Object.entries(properties).map(([name, property]) => ({
      name,
      required: required.has(name),
      node: describe(property, root, refs, depth + 1),
    }));
    const extra = schema.additionalProperties;
    if (fields.length === 0 && extra && typeof extra === 'object') {
      const value = describe(extra as JsonSchema, root, refs, depth + 1);
      return annotate({
        type: `Record<string, ${value.type}>${nullable}`,
        ...(value.fields ? { fields: value.fields } : {}),
      });
    }
    return annotate({
      type: `object${nullable}`,
      ...(fields.length > 0 ? { fields } : {}),
    });
  }

  if (nonNull.length === 0) return annotate({ type: nullable ? 'null' : 'any' });
  const base = nonNull.join(' | ');
  const range =
    base === 'number' || base === 'integer'
      ? bounds(schema, 'minimum', 'maximum') ||
        bounds(schema, 'exclusiveMinimum', 'exclusiveMaximum', '', true)
      : base === 'string'
        ? bounds(schema, 'minLength', 'maxLength', ' chars')
        : '';
  return annotate({ type: `${base}${range}${nullable}` });
}

function resolveRef(root: object, ref: string): JsonSchema | null {
  if (!ref.startsWith('#/')) return null;
  let node: unknown = root;
  for (const part of ref.slice(2).split('/')) {
    const key = part.replaceAll('~1', '/').replaceAll('~0', '~');
    if (node === null || typeof node !== 'object' || !Object.hasOwn(node, key)) return null;
    node = (node as Record<string, unknown>)[key];
  }
  return node !== null && typeof node === 'object' ? (node as JsonSchema) : null;
}

function bounds(
  schema: JsonSchema,
  minKey: string,
  maxKey: string,
  unit = '',
  exclusive = false,
): string {
  const min = typeof schema[minKey] === 'number' ? (schema[minKey] as number) : undefined;
  const max = typeof schema[maxKey] === 'number' ? (schema[maxKey] as number) : undefined;
  const [lo, hi] = exclusive ? ['>', '<'] : ['≥', '≤'];
  if (min !== undefined && max !== undefined) {
    return min === max && !exclusive ? ` (${min}${unit})` : ` ${lo} ${min}, ${hi} ${max}${unit}`;
  }
  if (min !== undefined) return ` ${lo} ${min}${unit}`;
  if (max !== undefined) return ` ${hi} ${max}${unit}`;
  return '';
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
