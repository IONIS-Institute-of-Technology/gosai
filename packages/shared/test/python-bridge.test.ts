import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { bridgeExecutable } from '../src/python-bridge.js';

test('bridgeExecutable follows the venv layout of each platform', () => {
  expect(bridgeExecutable('/py', 'linux')).toBe(join('/py', '.venv', 'bin', 'gosai-bridge'));
  expect(bridgeExecutable('/py', 'darwin')).toBe(join('/py', '.venv', 'bin', 'gosai-bridge'));
  expect(bridgeExecutable('/py', 'win32')).toBe(
    join('/py', '.venv', 'Scripts', 'gosai-bridge.exe'),
  );
});
