import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { resolveStaticFile } from '../src/apps/static-files.js';

function fixture(): { root: string; app: string; secret: string } {
  const root = mkdtempSync(join(tmpdir(), 'gosai-static-'));
  const app = join(root, 'app');
  mkdirSync(join(app, 'dist', 'assets'), { recursive: true });
  writeFileSync(join(app, 'dist', 'main.js'), 'export {}');
  writeFileSync(join(app, 'dist', 'assets', 'logo.png'), 'png');
  // A sibling whose name starts with the app directory's name.
  mkdirSync(join(root, 'app-secrets'));
  const secret = join(root, 'app-secrets', 'key.txt');
  writeFileSync(secret, 'secret');
  return { root, app, secret };
}

describe('static file resolution', () => {
  test('serves files inside the app', () => {
    const { app } = fixture();
    expect(resolveStaticFile(app, 'dist/main.js')).toEndWith(join('dist', 'main.js'));
    expect(resolveStaticFile(app, 'dist/./assets/../main.js')).toEndWith(join('dist', 'main.js'));
  });

  test('rejects traversal, absolute paths and directories', () => {
    const { app, secret } = fixture();
    expect(resolveStaticFile(app, '../app-secrets/key.txt')).toBeNull();
    expect(resolveStaticFile(app, '../../etc/passwd')).toBeNull();
    expect(resolveStaticFile(app, '..\\app-secrets\\key.txt')).toBeNull();
    expect(resolveStaticFile(app, secret)).toBeNull();
    expect(resolveStaticFile(app, 'dist')).toBeNull();
    expect(resolveStaticFile(app, '')).toBeNull();
    expect(resolveStaticFile(app, 'dist/missing.js')).toBeNull();
    expect(resolveStaticFile(app, 'dist/main.js\0.png')).toBeNull();
  });

  test("rejects the app's private data, settings and dot paths", () => {
    const { app } = fixture();
    mkdirSync(join(app, '_data', 'storage'), { recursive: true });
    writeFileSync(join(app, '_data', 'storage', 'secret.json'), '{}');
    mkdirSync(join(app, '_config'));
    writeFileSync(join(app, '_config', 'settings.json'), '{}');
    mkdirSync(join(app, '.git'));
    writeFileSync(join(app, '.git', 'config'), '');
    writeFileSync(join(app, '.env'), 'KEY=1');
    writeFileSync(join(app, 'dist', '.secret'), '');
    // Only the top-level directories are private.
    mkdirSync(join(app, 'dist', '_data'));
    writeFileSync(join(app, 'dist', '_data', 'level.json'), '{}');

    expect(resolveStaticFile(app, '_data/storage/secret.json')).toBeNull();
    expect(resolveStaticFile(app, 'dist/../_data/storage/secret.json')).toBeNull();
    expect(resolveStaticFile(app, '_config/settings.json')).toBeNull();
    expect(resolveStaticFile(app, '.git/config')).toBeNull();
    expect(resolveStaticFile(app, '.env')).toBeNull();
    expect(resolveStaticFile(app, 'dist/.secret')).toBeNull();
    expect(resolveStaticFile(app, 'dist/_data/level.json')).toEndWith(join('_data', 'level.json'));

    symlinkSync(join(app, '_data', 'storage', 'secret.json'), join(app, 'dist', 'alias.json'));
    expect(resolveStaticFile(app, 'dist/alias.json')).toBeNull();
  });

  test('rejects symlinks that leave the app', () => {
    const { app, root, secret } = fixture();
    symlinkSync(secret, join(app, 'dist', 'leak.txt'));
    symlinkSync(join(root, 'app-secrets'), join(app, 'dist', 'linked-dir'), 'dir');
    expect(resolveStaticFile(app, 'dist/leak.txt')).toBeNull();
    expect(resolveStaticFile(app, 'dist/linked-dir/key.txt')).toBeNull();
  });

  test('follows symlinks that stay inside the app, and a symlinked app root', () => {
    const { app, root } = fixture();
    symlinkSync(join(app, 'dist', 'main.js'), join(app, 'entry.js'));
    expect(resolveStaticFile(app, 'entry.js')).toEndWith(join('dist', 'main.js'));

    const linkedRoot = join(root, 'linked-app');
    symlinkSync(app, linkedRoot, 'dir');
    expect(resolveStaticFile(linkedRoot, 'dist/main.js')).toEndWith(join('dist', 'main.js'));
  });
});
