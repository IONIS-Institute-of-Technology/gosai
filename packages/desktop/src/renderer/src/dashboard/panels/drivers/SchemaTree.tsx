import type { JsonSchema } from '@gosai/shared';
import { describeSchema, type SchemaField, type SchemaNode } from '../../../lib/json-schema.js';

/** A schema's type, then its fields as an indented list. */
export function SchemaTree({
  schema,
  root,
}: {
  readonly schema: JsonSchema | null | undefined;
  readonly root: object;
}): React.ReactElement {
  const node = describeSchema(schema, root);
  return (
    <div className="font-mono text-[11px]">
      <span className="text-sky-300">{node.type}</span>
      {node.fields ? <Fields fields={node.fields} /> : null}
    </div>
  );
}

function Fields({ fields }: { readonly fields: readonly SchemaField[] }): React.ReactElement {
  return (
    <ul className="mt-0.5 space-y-0.5 border-l border-neutral-800 pl-3">
      {fields.map((field) => (
        <li key={field.name}>
          <FieldLine field={field} />
          {field.node.fields ? <Fields fields={field.node.fields} /> : null}
        </li>
      ))}
    </ul>
  );
}

function FieldLine({ field }: { readonly field: SchemaField }): React.ReactElement {
  const node: SchemaNode = field.node;
  return (
    <div className="flex flex-wrap items-baseline gap-x-2">
      <span className="text-neutral-200">
        {field.name}
        {field.required ? '' : '?'}
      </span>
      <span className="text-sky-300">{node.type}</span>
      {node.default !== undefined ? (
        <span className="text-neutral-500">= {node.default}</span>
      ) : null}
      {node.description ? (
        <span className="font-sans text-neutral-500">{node.description}</span>
      ) : null}
    </div>
  );
}
