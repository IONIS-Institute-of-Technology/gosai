/**
 * Writes `src/protocol-types.ts`: the request, response and event payload
 * types of every command and fixed event, expanded from the zod schemas in
 * `protocol-schemas.ts` into plain TypeScript.
 *
 * `protocol.ts` exports its types from that file, so the client, and the
 * published SDK's declarations that inline it, never need zod. Run
 * `bun run generate:protocol-types` after changing a protocol schema;
 * `test/protocol-types.test.ts` stops type-checking while the file is stale.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from '@typescript/typescript6';
import prettier from 'prettier';

const packageDir = resolve(import.meta.dir, '..');
const srcDir = resolve(packageDir, 'src');
const target = resolve(srcDir, 'protocol-types.ts');
/** A file that only exists in the program, so nothing is written to disk. */
const probePath = resolve(srcDir, '__protocol-types-probe__.ts');

/** Maps to generate: name, doc comment, and the type the probe expands. */
const MAPS = [
  {
    name: 'CommandRequests',
    doc: 'What a client sends for each command. Fields with defaults may be left out.',
    type: "{ [C in keyof Commands]: z.input<Commands[C]['request']> }",
  },
  {
    name: 'ParsedCommandRequests',
    doc: 'What the server hands each command handler, after validation.',
    type: "{ [C in keyof Commands]: z.output<Commands[C]['request']> }",
  },
  {
    name: 'CommandResponses',
    doc: "Each command's reply.",
    type: "{ [C in keyof Commands]: z.output<Commands[C]['response']> }",
  },
  {
    name: 'FixedEventPayloadMap',
    doc: 'Payload of each event with a fixed name.',
    type: '{ [E in keyof Events]: z.output<Events[E]> }',
  },
] as const;

/** Exported type names of a module, so the probe can print them unqualified. */
function exportedTypeNames(file: string): string[] {
  const source = readFileSync(resolve(srcDir, file), 'utf8');
  return Array.from(source.matchAll(/^export (?:interface|type) (\w+)/gm), (match) => match[1]!);
}

export async function generateProtocolTypes(): Promise<string> {
  const typeNames = exportedTypeNames('types.ts');
  const capabilityNames = exportedTypeNames('capabilities.ts');
  const probe = [
    "import type { z } from 'zod';",
    "import type { commandSchemas, eventSchemas } from './protocol-schemas.js';",
    `import type { ${typeNames.join(', ')} } from './types.js';`,
    `import type { ${capabilityNames.join(', ')} } from './capabilities.js';`,
    'type Commands = typeof commandSchemas;',
    'type Events = typeof eventSchemas;',
    ...MAPS.map((map) => `export type ${map.name} = ${map.type};`),
  ].join('\n');

  const config = ts.getParsedCommandLineOfConfigFile(
    resolve(packageDir, 'tsconfig.json'),
    {},
    { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined },
  );
  if (!config) throw new Error('could not read packages/shared/tsconfig.json');
  const host = ts.createCompilerHost(config.options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, ...rest) =>
    fileName === probePath
      ? ts.createSourceFile(fileName, probe, languageVersion, true)
      : getSourceFile(fileName, languageVersion, ...rest);
  const fileExists = host.fileExists.bind(host);
  host.fileExists = (fileName) => fileName === probePath || fileExists(fileName);

  // The probe imports every type name so they print unqualified, used or not.
  const options = { ...config.options, noUnusedLocals: false };
  const program = ts.createProgram([probePath], options, host);
  const errors = ts.getPreEmitDiagnostics(program, program.getSourceFile(probePath));
  if (errors.length > 0) {
    throw new Error(ts.formatDiagnostics(errors, host));
  }
  const checker = program.getTypeChecker();
  const sourceFile = program.getSourceFile(probePath)!;
  const printer = ts.createPrinter({ removeComments: true });
  const flags =
    ts.NodeBuilderFlags.NoTruncation |
    ts.NodeBuilderFlags.InTypeAlias |
    ts.NodeBuilderFlags.MultilineObjectLiterals;

  const used = new Set<string>();
  const blocks: string[] = [];
  for (const map of MAPS) {
    const alias = sourceFile.statements.find(
      (statement): statement is ts.TypeAliasDeclaration =>
        ts.isTypeAliasDeclaration(statement) && statement.name.text === map.name,
    )!;
    const members = checker
      .getPropertiesOfType(checker.getTypeAtLocation(alias.name))
      .map((property) => {
        const type = checker.getTypeOfSymbolAtLocation(property, alias);
        const node = checker.typeToTypeNode(type, alias, flags);
        if (!node) throw new Error(`could not print ${map.name}['${property.name}']`);
        const text = printer.printNode(ts.EmitHint.Unspecified, node, sourceFile);
        if (text.includes('import(')) {
          throw new Error(`${map.name}['${property.name}'] refers to a type the probe can't name`);
        }
        for (const name of [...typeNames, ...capabilityNames]) {
          if (new RegExp(`\\b${name}\\b`).test(text)) used.add(name);
        }
        return `  ${JSON.stringify(property.name)}: ${text};`;
      });
    blocks.push(`/** ${map.doc} */\nexport interface ${map.name} {\n${members.join('\n')}\n}`);
  }

  const importsFrom = (names: readonly string[], file: string): string[] => {
    const picked = names.filter((name) => used.has(name));
    return picked.length > 0 ? [`import type { ${picked.join(', ')} } from '${file}';`] : [];
  };
  const text = [
    '/**',
    ' * Generated by `bun run generate:protocol-types` (scripts/generate-protocol-types.ts)',
    ' * from the zod schemas in protocol-schemas.ts. Do not edit.',
    ' *',
    " * Plain types, so the client and the SDK's published declarations don't need zod.",
    ' */',
    '',
    ...importsFrom(capabilityNames, './capabilities.js'),
    ...importsFrom(typeNames, './types.js'),
    '',
    blocks.join('\n\n'),
    '',
  ].join('\n');
  const prettierOptions = await prettier.resolveConfig(target);
  return prettier.format(text, { ...prettierOptions, filepath: target });
}

if (import.meta.main) {
  writeFileSync(target, await generateProtocolTypes());
  console.log(`wrote ${target}`);
}
