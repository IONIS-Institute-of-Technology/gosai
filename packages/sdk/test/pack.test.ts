import { describe, expect, test } from 'bun:test';
import sdkPackage from '../package.json' with { type: 'json' };
import { publishedManifest } from '../scripts/pack.js';

describe('packing', () => {
  test('the published package.json drops what only the repository uses', () => {
    const published = publishedManifest(sdkPackage);
    expect(published).not.toHaveProperty('scripts');
    expect(published).not.toHaveProperty('devDependencies');
    expect(JSON.stringify(published.exports)).not.toContain('@gosai/source');
    expect(published.exports).toEqual({
      '.': { types: './dist/index.d.ts', import: './dist/index.js' },
      './host': { types: './dist/host.d.ts', import: './dist/host.js' },
      './gosai.app.schema.json': './dist/gosai.app.schema.json',
      './package.json': './package.json',
    });
    expect(published).toMatchObject({
      name: '@gosai/sdk',
      version: sdkPackage.version,
      bin: { 'gosai-sdk': './dist/cli/gosai-sdk.js' },
      engines: { node: expect.any(String) },
    });
  });
});
