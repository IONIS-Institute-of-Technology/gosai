import { describe, expect, test } from 'bun:test';
import { describeSchema } from '../src/renderer/src/lib/json-schema.js';

const root = {
  $defs: {
    Point: {
      type: 'object',
      properties: {
        x: { type: 'number' },
        y: { type: 'number', description: 'Down is positive.' },
      },
      required: ['x'],
    },
    Tree: {
      type: 'object',
      properties: { children: { type: 'array', items: { $ref: '#/$defs/Tree' } } },
    },
  },
};

describe('describeSchema', () => {
  test('resolves refs against the driver root and lists fields', () => {
    expect(describeSchema({ $ref: '#/$defs/Point' }, root)).toEqual({
      type: 'Point',
      fields: [
        { name: 'x', required: true, node: { type: 'number' } },
        {
          name: 'y',
          required: false,
          node: { type: 'number', description: 'Down is positive.' },
        },
      ],
    });
    expect(describeSchema({ $ref: '#/$defs/Missing' }, root).type).toBe('Missing (unresolved)');
  });

  test('describes arrays, unions, bounds, enums and defaults', () => {
    expect(
      describeSchema({ type: 'array', items: { type: 'number' }, minItems: 9, maxItems: 9 }, root)
        .type,
    ).toBe('number[] (9 items)');
    expect(
      describeSchema({ anyOf: [{ type: 'null' }, { $ref: '#/$defs/Point' }] }, root),
    ).toMatchObject({
      type: 'null | Point',
      fields: [{ name: 'x' }, { name: 'y' }],
    });
    expect(describeSchema({ type: 'integer', minimum: 0, default: 3 }, root)).toEqual({
      type: 'integer ≥ 0',
      default: '3',
    });
    expect(describeSchema({ enum: ['latest', 'ordered'] }, root).type).toBe('"latest" | "ordered"');
    expect(
      describeSchema({ type: 'object', additionalProperties: { type: 'string' } }, root).type,
    ).toBe('Record<string, string>');
    expect(describeSchema(null, root).type).toBe('none');
  });

  test('stops at recursive definitions', () => {
    const tree = describeSchema({ $ref: '#/$defs/Tree' }, root);
    expect(tree.fields?.[0]?.node).toEqual({ type: 'Tree[]' });
  });
});
