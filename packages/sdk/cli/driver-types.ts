/**
 * Turns driver schemas into TypeScript types for `rt.drivers` and a Markdown
 * reference. `gosai-sdk gen-driver-types` runs it; so does the GOSAI
 * repository for the built-in drivers.
 *
 * Input is either the output of `python -m gosai_py.schemas`
 * (`{ "drivers": [{ name, description, schema, ... }] }`) or the reply to the
 * server's `drivers:schema` command (`{ "schemas": { <name>: { schema } } }`).
 * Each driver's `$ref`s resolve against its own `$defs`, so every driver gets
 * its own namespace. Drivers an app ships are named `<app slug>/<driver>`;
 * their namespace is the part after the slash.
 */

/** A JSON Schema, as far as the generator reads it. */
export type JsonSchema = boolean | { readonly [keyword: string]: unknown };

export interface DriverSchema {
  readonly config: JsonSchema | null;
  readonly events: Readonly<
    Record<
      string,
      {
        readonly description?: string;
        readonly delivery?: string;
        readonly queue_size?: number;
        readonly payload: JsonSchema;
      }
    >
  >;
  readonly actions: Readonly<
    Record<
      string,
      {
        readonly description?: string;
        readonly params: JsonSchema | null;
        readonly result: JsonSchema;
        readonly requires_instance?: boolean;
      }
    >
  >;
  readonly $defs?: Readonly<Record<string, JsonSchema>>;
}

export interface DriverDescription {
  readonly name: string;
  readonly description?: string;
  readonly dependencies?: readonly string[];
  readonly shared?: boolean;
  /** `null` when the driver's types couldn't be described. Its events and actions stay untyped. */
  readonly schema: DriverSchema | null;
}

export type DriverTypesTarget =
  /** The SDK's own file: exports `DriverTypes` and `BuiltinDrivers`. */
  | { readonly kind: 'builtin' }
  /** An app's file: exports `namespace` and adds its drivers to `module`'s `DriverRegistry`. */
  | { readonly kind: 'augment'; readonly module: string; readonly namespace: string };

/** `hand_pose`, or `<app slug>/<driver>` for a driver an app ships. */
const DRIVER_NAME = /^(?:[a-z][a-z0-9-]*\/)?[a-z][a-z0-9_]*$/;
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const RESERVED = new Set(
  (
    'break case catch class const continue debugger default delete do else enum export extends ' +
    'false finally for function if import in instanceof new null return super switch this throw ' +
    'true try typeof var void while with implements interface let package private protected ' +
    'public static yield any boolean number string symbol unknown never object undefined type ' +
    'namespace module declare abstract as async await constructor get set readonly keyof infer'
  ).split(' '),
);

/** Reads either input shape and returns the drivers sorted by name. */
export function readDriverSchemas(input: unknown): DriverDescription[] {
  if (!isRecord(input)) throw new Error('driver schemas must be a JSON object');
  let drivers: DriverDescription[];
  if (Array.isArray(input.drivers)) {
    drivers = input.drivers.map((entry, index) => {
      if (!isRecord(entry) || typeof entry.name !== 'string') {
        throw new Error(`drivers[${index}] has no name`);
      }
      return {
        name: entry.name,
        ...(typeof entry.description === 'string' ? { description: entry.description } : {}),
        ...(Array.isArray(entry.dependencies)
          ? { dependencies: entry.dependencies.filter((d): d is string => typeof d === 'string') }
          : {}),
        ...(typeof entry.shared === 'boolean' ? { shared: entry.shared } : {}),
        schema: readSchema(entry.schema, entry.name),
      };
    });
  } else if (isRecord(input.schemas)) {
    drivers = Object.entries(input.schemas).map(([name, entry]) => ({
      name,
      schema: readSchema(isRecord(entry) ? entry.schema : null, name),
    }));
  } else {
    throw new Error('expected { "drivers": [...] } or { "schemas": { ... } }');
  }
  for (const driver of drivers) {
    if (!DRIVER_NAME.test(driver.name)) {
      throw new Error(`"${driver.name}" is not a driver name like hand_pose or my-app/my_driver`);
    }
  }
  return drivers.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function readSchema(value: unknown, driver: string): DriverSchema | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value) || !isRecord(value.events) || !isRecord(value.actions)) {
    throw new Error(`the schema of ${driver} needs "events" and "actions" objects`);
  }
  return value as unknown as DriverSchema;
}

/** The TypeScript module for `drivers`. */
export function driverTypesModule(
  drivers: readonly DriverDescription[],
  target: DriverTypesTarget,
): string {
  const root = target.kind === 'builtin' ? 'DriverTypes' : target.namespace;
  if (!IDENTIFIER.test(root) || RESERVED.has(root)) {
    throw new Error(`"${root}" can't be a namespace name`);
  }
  const namespaces = new Map<string, string>();
  for (const driver of drivers) {
    const namespace = namespaceName(driver.name);
    const other = namespaces.get(namespace);
    if (other !== undefined) {
      throw new Error(
        `${other} and ${driver.name} would share the namespace ${namespace}; pick one with --drivers`,
      );
    }
    namespaces.set(namespace, driver.name);
  }
  const out: string[] = [];
  out.push(
    '/**',
    target.kind === 'builtin'
      ? ' * Types of the built-in drivers, generated from their Python schemas by'
      : ' * Driver types generated from driver schemas by `gosai-sdk gen-driver-types`.',
    target.kind === 'builtin' ? ' * `bun run drivers:types`. Do not edit.' : ' * Do not edit.',
    ' */',
    '',
  );
  if (target.kind === 'augment') {
    out.push(`import type {} from ${JSON.stringify(target.module)};`, '');
  }

  out.push(`export declare namespace ${root} {`);
  drivers.forEach((driver, index) => {
    if (index > 0) out.push('');
    out.push(...indent(driverNamespace(driver), 1));
  });
  out.push('}', '');

  const entries = drivers.flatMap((driver) => registryEntry(driver, root));
  if (target.kind === 'builtin') {
    out.push('/** Event and action types of every built-in driver, by driver name. */');
    out.push('export interface BuiltinDrivers {', ...indent(entries, 1), '}');
  } else {
    out.push(`declare module ${JSON.stringify(target.module)} {`);
    out.push('  interface DriverRegistry {', ...indent(entries, 2), '  }', '}');
  }
  return `${out.join('\n')}\n`;
}

function driverNamespace(driver: DriverDescription): string[] {
  const lines = doc(driver.description);
  lines.push(`export namespace ${namespaceName(driver.name)} {`);
  const defs = Object.entries(driver.schema?.$defs ?? {});
  defs.forEach(([name, schema], index) => {
    if (index > 0) lines.push('');
    const types = new TypeWriter(driver.name, (ref) => ref);
    lines.push(...indent(types.declaration(typeName(name), schema), 1));
  });
  lines.push('}');
  return lines;
}

function registryEntry(driver: DriverDescription, root: string): string[] {
  const lines = doc(driver.description);
  const key = propertyKey(driver.name);
  const schema = driver.schema;
  if (!schema) {
    lines.push(
      `${key}: {`,
      '  config: unknown;',
      '  events: { [event: string]: unknown };',
      '  actions: { [action: string]: { params: unknown; result: unknown } };',
      '};',
    );
    return lines;
  }
  const qualify = (name: string): string => `${root}.${namespaceName(driver.name)}.${name}`;
  const types = new TypeWriter(driver.name, qualify);
  lines.push(`${key}: {`);
  const config = schema.config === null ? 'undefined' : types.type(schema.config);
  lines.push(embed('  config: ', config, ';'));
  lines.push('  events: {');
  for (const [name, event] of Object.entries(schema.events)) {
    lines.push(...indent(doc(event.description), 2));
    lines.push(embed(`    ${propertyKey(name)}: `, types.type(event.payload), ';'));
  }
  lines.push('  };', '  actions: {');
  for (const [name, action] of Object.entries(schema.actions)) {
    lines.push(...indent(doc(action.description), 2));
    const params = action.params === null ? 'undefined' : types.type(action.params);
    lines.push(`    ${propertyKey(name)}: {`);
    lines.push(embed('      params: ', params, ';'));
    lines.push(embed('      result: ', types.type(action.result), ';'));
    lines.push('    };');
  }
  lines.push('  };', '};');
  return lines;
}

/** Converts JSON Schema into TypeScript type expressions. */
class TypeWriter {
  constructor(
    private readonly driver: string,
    /** How a `$defs` name is written where the type is used. */
    private readonly refName: (name: string) => string,
  ) {}

  /** `export interface` for plain objects, `export type` for anything else. */
  declaration(name: string, schema: JsonSchema): string[] {
    const lines = isRecord(schema) ? doc(schema.description) : [];
    if (isRecord(schema) && isPlainObject(schema)) {
      lines.push(`export interface ${name} ${this.objectType(schema)}`);
    } else {
      lines.push(embed(`export type ${name} = `, this.type(schema), ';'));
    }
    return lines;
  }

  /** A type expression. Lines after the first are indented as if it started at column 0. */
  type(schema: JsonSchema): string {
    if (schema === true) return 'unknown';
    if (schema === false) return 'never';
    if (typeof schema.$ref === 'string') return this.ref(schema.$ref);
    if ('const' in schema) return literal(schema.const);
    if (Array.isArray(schema.enum)) return union(schema.enum.map(literal));
    for (const keyword of ['anyOf', 'oneOf'] as const) {
      const options = schema[keyword];
      if (Array.isArray(options)) {
        return union(options.map((option) => this.type(option as JsonSchema)));
      }
    }
    if (Array.isArray(schema.allOf)) {
      return schema.allOf.map((part) => wrapOperators(this.type(part as JsonSchema))).join(' & ');
    }
    if (Array.isArray(schema.type)) {
      return union(schema.type.map((type) => this.type({ ...schema, type })));
    }
    switch (schema.type) {
      case 'null':
        return 'null';
      case 'boolean':
        return 'boolean';
      case 'string':
        return 'string';
      case 'number':
      case 'integer':
        return 'number';
      case 'array':
        return this.arrayType(schema);
      case 'object':
        return this.objectType(schema);
      case undefined:
        return 'properties' in schema ? this.objectType(schema) : 'unknown';
      default:
        throw new Error(`${this.driver}: unsupported JSON Schema type ${String(schema.type)}`);
    }
  }

  private ref(ref: string): string {
    const match = /^#\/\$defs\/(.+)$/.exec(ref);
    if (!match?.[1]) throw new Error(`${this.driver}: only #/$defs/ references are supported`);
    return this.refName(typeName(decodeURIComponent(match[1])));
  }

  private arrayType(schema: { readonly [keyword: string]: unknown }): string {
    const items = schema.items as JsonSchema | undefined;
    if (Array.isArray(schema.prefixItems)) {
      const members = schema.prefixItems.map((item) => this.type(item as JsonSchema));
      if (items !== undefined && items !== false) {
        members.push(`...${wrapOperators(this.type(items))}[]`);
      }
      return `[${members.join(', ')}]`;
    }
    const item = items === undefined ? 'unknown' : this.type(items);
    return `${wrapOperators(item)}[]`;
  }

  private objectType(schema: { readonly [keyword: string]: unknown }): string {
    const properties = isRecord(schema.properties) ? Object.entries(schema.properties) : [];
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    const additional = schema.additionalProperties as JsonSchema | undefined;
    if (properties.length === 0) {
      const values = additional === undefined || additional === false ? true : additional;
      return embed('{ [key: string]: ', this.type(values), ' }');
    }
    const lines = ['{'];
    for (const [name, property] of properties) {
      const value = property as JsonSchema;
      const optional = required.has(name) ? '' : '?';
      lines.push(...indent(isRecord(value) ? propertyDoc(value) : [], 1));
      lines.push(embed(`  ${propertyKey(name)}${optional}: `, this.type(value), ';'));
    }
    if (additional !== undefined && additional !== false) {
      lines.push('  [key: string]: unknown;');
    }
    lines.push('}');
    return lines.join('\n');
  }
}

/** The Markdown reference page for `drivers`. */
export function driverReference(
  drivers: readonly DriverDescription[],
  options: { readonly title?: string; readonly intro?: string; readonly namespace?: string } = {},
): string {
  const root = options.namespace ?? 'DriverTypes';
  const out: string[] = [`# ${options.title ?? 'Driver reference'}`, ''];
  if (options.intro) out.push(options.intro, '');
  for (const driver of drivers) {
    out.push(`- [\`${driver.name}\`](#${anchor(driver.name)})${summary(driver.description)}`);
  }
  for (const driver of drivers) {
    out.push('', `## ${driver.name}`, '');
    if (driver.description) out.push(oneParagraph(driver.description), '');
    const facts: string[] = [];
    if (driver.dependencies && driver.dependencies.length > 0) {
      facts.push(`Starts ${driver.dependencies.map((d) => `\`${d}\``).join(', ')} first.`);
    }
    if (driver.shared !== undefined) {
      facts.push(
        driver.shared
          ? 'Shared: every app uses the same instance.'
          : 'Exclusive: each app binding gets its own instance.',
      );
    }
    if (facts.length > 0) out.push(facts.join(' '), '');
    const schema = driver.schema;
    if (!schema) {
      out.push('This driver has no schema, so its events and actions are typed `unknown`.');
      continue;
    }
    const namespace = `${root}.${namespaceName(driver.name)}`;
    out.push(`Types: \`${namespace}\`.`, '');
    const types = new TypeWriter(driver.name, (name) => name);
    const cell = (text: string): string =>
      text.replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|') || ' ';
    const code = (schema: JsonSchema): string => `\`${cell(types.type(schema))}\``;

    if (schema.config !== null) out.push(`Config: ${code(schema.config)}`, '');

    const events = Object.entries(schema.events);
    out.push('### Events', '');
    if (events.length === 0) {
      out.push('None.');
    } else {
      out.push('| Event | Payload | Delivery | Description |', '| --- | --- | --- | --- |');
      for (const [name, event] of events) {
        const delivery =
          event.delivery === 'buffered' && event.queue_size !== undefined
            ? `buffered (${event.queue_size})`
            : (event.delivery ?? '');
        out.push(
          `| \`${name}\` | ${code(event.payload)} | ${delivery} | ${cell(event.description ?? '')} |`,
        );
      }
    }

    const actions = Object.entries(schema.actions);
    out.push('', '### Actions', '');
    if (actions.length === 0) {
      out.push('None.');
    } else {
      out.push('| Action | Params | Result | Description |', '| --- | --- | --- | --- |');
      for (const [name, action] of actions) {
        const params = action.params === null ? 'none' : code(action.params);
        const note =
          action.requires_instance === false ? ' Works before the driver has started.' : '';
        out.push(
          `| \`${name}\` | ${params} | ${code(action.result)} | ${cell((action.description ?? '') + note)} |`,
        );
      }
    }

    const defs = Object.entries(schema.$defs ?? {});
    if (defs.length > 0) {
      out.push('', '### Types', '', '```ts');
      defs.forEach(([name, def], index) => {
        if (index > 0) out.push('');
        out.push(...types.declaration(typeName(name), def));
      });
      out.push('```');
    }
  }
  return `${out.join('\n')}\n`;
}

function isRecord(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPlainObject(schema: { readonly [keyword: string]: unknown }): boolean {
  return (
    (schema.type === 'object' || schema.type === undefined) &&
    isRecord(schema.properties) &&
    Object.keys(schema.properties).length > 0 &&
    !['$ref', 'anyOf', 'oneOf', 'allOf', 'enum', 'const'].some((keyword) => keyword in schema)
  );
}

/** The driver's name, without the app prefix of an app driver. */
function namespaceName(driver: string): string {
  const name = driver.slice(driver.indexOf('/') + 1);
  return RESERVED.has(name) ? `${name}_` : name;
}

/** The id GitHub gives the `## <driver>` heading. */
function anchor(driver: string): string {
  return driver.replace(/[^a-z0-9_-]/g, '');
}

function typeName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_$]/g, '_');
  const safe = /^[0-9]/.test(cleaned) ? `_${cleaned}` : cleaned;
  return RESERVED.has(safe) ? `${safe}_` : safe;
}

function propertyKey(name: string): string {
  return IDENTIFIER.test(name) ? name : JSON.stringify(name);
}

function literal(value: unknown): string {
  return value === undefined ? 'undefined' : JSON.stringify(value);
}

function union(members: readonly string[]): string {
  const unique = Array.from(new Set(members));
  if (unique.includes('unknown')) return 'unknown';
  if (unique.length === 0) return 'never';
  return unique.map((type) => (/&/.test(stripNested(type)) ? `(${type})` : type)).join(' | ');
}

/** Parenthesizes a union or intersection before `[]` or `&`. */
function wrapOperators(type: string): string {
  return /[|&]/.test(stripNested(type)) ? `(${type})` : type;
}

/** The type text with bracketed and quoted parts removed, to find top-level operators. */
function stripNested(type: string): string {
  let depth = 0;
  let quote: string | null = null;
  let out = '';
  for (let i = 0; i < type.length; i++) {
    const char = type[i]!;
    if (quote) {
      if (char === '\\') i++;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if ('{[(<'.includes(char)) depth++;
    else if ('}])>'.includes(char)) depth--;
    else if (depth === 0) out += char;
  }
  return out;
}

function doc(text: unknown, extra: readonly string[] = []): string[] {
  const lines = typeof text === 'string' ? paragraphLines(text) : [];
  const all = [...lines, ...extra];
  if (all.length === 0) return [];
  if (all.length === 1) return [`/** ${escapeComment(all[0]!)} */`];
  return ['/**', ...all.map((line) => (line === '' ? ' *' : ` * ${escapeComment(line)}`)), ' */'];
}

function propertyDoc(schema: { readonly [keyword: string]: unknown }): string[] {
  const extra = 'default' in schema ? [`@default ${JSON.stringify(schema.default)}`] : [];
  return doc(schema.description, extra);
}

/** Docstring lines with their indentation removed. */
function paragraphLines(text: string): string[] {
  const lines = text.split('\n').map((line) => line.trim());
  while (lines[0] === '') lines.shift();
  while (lines.at(-1) === '') lines.pop();
  return lines;
}

function oneParagraph(text: string): string {
  return paragraphLines(text).join(' ');
}

function summary(description: string | undefined): string {
  return description ? `: ${oneParagraph(description)}` : '';
}

function escapeComment(text: string): string {
  return text.replace(/\*\//g, '*\\/');
}

/** `prefix`, `type` and `suffix` on one line, with the type's later lines indented like the prefix. */
function embed(prefix: string, type: string, suffix = ''): string {
  const pad = /^ */.exec(prefix)?.[0] ?? '';
  return `${prefix}${type.replace(/\n(?=.)/g, `\n${pad}`)}${suffix}`;
}

/** Indents every non-empty line, including the lines inside multi-line strings. */
function indent(lines: readonly string[], levels: number): string[] {
  const pad = '  '.repeat(levels);
  return lines.map((line) => line.replace(/^(?=.)/gm, pad));
}
