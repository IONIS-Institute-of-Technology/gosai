import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  bridgeExecutable,
  cleanStaleRuntimes,
  COMPLETE_MARKER,
  hashPythonTree,
  materializeRuntime,
  pythonVersionFromPyproject,
  readPythonRuntimeInfo,
  releaseInUse,
  runtimeName,
  type MaterializeOptions,
} from '../src/main/python-runtime.js';

let root: string;
let source: string;
let runtimeRoot: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gosai-python-runtime-'));
  source = join(root, 'resources', 'python');
  runtimeRoot = join(root, 'runtime');
  mkdirSync(join(source, 'src', 'gosai_py'), { recursive: true });
  writeFileSync(join(source, 'pyproject.toml'), '[project]\nrequires-python = ">=3.12"\n');
  writeFileSync(join(source, 'uv.lock'), 'lock');
  writeFileSync(join(source, 'src', 'gosai_py', 'bridge.py'), 'print("hi")');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A pid that no longer exists. */
function deadPid(): number {
  const child = Bun.spawnSync({ cmd: ['true'] });
  return child.pid;
}

/** Stands in for `uv sync`: creates the venv entry point. */
function fakeUv(platform: NodeJS.Platform = 'linux', calls: string[][] = []) {
  return async (args: readonly string[], cwd: string): Promise<void> => {
    calls.push([...args]);
    const bridge = bridgeExecutable(cwd, platform);
    mkdirSync(join(bridge, '..'), { recursive: true });
    writeFileSync(bridge, '');
  };
}

function options(overrides: Partial<MaterializeOptions> = {}): MaterializeOptions {
  return {
    sourceDir: source,
    runtimeRoot,
    name: 'python-abc',
    commands: [['venv'], ['sync']],
    runUv: fakeUv(),
    lockPollMs: 10,
    ...overrides,
  };
}

describe('pythonVersionFromPyproject', () => {
  test('takes the lower bound of requires-python', () => {
    expect(pythonVersionFromPyproject('requires-python = ">=3.12"')).toBe('3.12');
    expect(pythonVersionFromPyproject("[project]\nrequires-python='>=3.13.1,<4'")).toBe('3.13');
    expect(pythonVersionFromPyproject('requires-python = "~=3.11.2"')).toBe('3.11');
  });

  test('fails without a usable bound', () => {
    expect(() => pythonVersionFromPyproject('[project]\nname = "x"')).toThrow('no requires-python');
    expect(() => pythonVersionFromPyproject('requires-python = "<4"')).toThrow('no lower bound');
  });

  test('matches the repository pyproject', () => {
    const pyproject = readFileSync(
      join(import.meta.dir, '..', '..', '..', 'python', 'pyproject.toml'),
      'utf8',
    );
    expect(pythonVersionFromPyproject(pyproject)).toMatch(/^3\.\d+$/);
  });
});

describe('hashPythonTree and runtimeName', () => {
  test('ignore venvs and caches but see source changes', () => {
    const before = hashPythonTree(source);
    mkdirSync(join(source, '.venv', 'bin'), { recursive: true });
    mkdirSync(join(source, 'src', 'gosai_py', '__pycache__'), { recursive: true });
    writeFileSync(join(source, 'src', 'gosai_py', '__pycache__', 'bridge.pyc'), 'x');
    writeFileSync(join(source, '.venv', 'bin', 'python'), 'x');
    expect(hashPythonTree(source)).toBe(before);

    writeFileSync(join(source, 'src', 'gosai_py', 'bridge.py'), 'print("changed")');
    expect(hashPythonTree(source)).not.toBe(before);
  });

  test('depend on the tree, the Python version and the extras, not their order', () => {
    const info = { treeHash: 'a', python: '3.12' };
    const name = runtimeName(info, ['speech', 'gpu']);
    expect(name).toMatch(/^python-[0-9a-f]{12}$/);
    expect(runtimeName(info, ['gpu', 'speech'])).toBe(name);
    expect(runtimeName(info, ['gpu'])).not.toBe(name);
    expect(runtimeName({ ...info, python: '3.13' }, ['speech', 'gpu'])).not.toBe(name);
    expect(runtimeName({ ...info, treeHash: 'b' }, ['speech', 'gpu'])).not.toBe(name);
  });

  test('readPythonRuntimeInfo explains a missing or bad file', () => {
    expect(() => readPythonRuntimeInfo(join(root, 'python-runtime.json'))).toThrow('repackage');
    writeFileSync(join(root, 'python-runtime.json'), '{"treeHash": 1}');
    expect(() => readPythonRuntimeInfo(join(root, 'python-runtime.json'))).toThrow('treeHash');
  });
});

describe('materializeRuntime', () => {
  test('stages, marks complete, renames, and reuses the result', async () => {
    const calls: string[][] = [];
    const pythonDir = await materializeRuntime(options({ runUv: fakeUv('linux', calls), pid: 42 }));
    const finalDir = join(runtimeRoot, 'python-abc');
    expect(pythonDir).toBe(join(finalDir, 'python'));
    expect(calls).toEqual([['venv'], ['sync']]);
    expect(existsSync(join(finalDir, COMPLETE_MARKER))).toBe(true);
    expect(existsSync(join(pythonDir, 'src', 'gosai_py', 'bridge.py'))).toBe(true);
    expect(existsSync(join(finalDir, '.in-use', '42'))).toBe(true);
    expect(readdirSync(runtimeRoot)).toEqual(['python-abc']);

    const again: string[][] = [];
    await materializeRuntime(options({ runUv: fakeUv('linux', again) }));
    expect(again).toEqual([]);
  });

  test('uses the Windows venv layout', async () => {
    const pythonDir = await materializeRuntime(
      options({ platform: 'win32', runUv: fakeUv('win32') }),
    );
    expect(existsSync(join(pythonDir, '.venv', 'Scripts', 'gosai-bridge.exe'))).toBe(true);
    await expect(
      materializeRuntime(
        options({ name: 'python-def', platform: 'win32', runUv: fakeUv('linux') }),
      ),
    ).rejects.toThrow('gosai-bridge entry point is missing');
  });

  test('leaves nothing behind when uv fails, and rebuilds an unmarked runtime', async () => {
    const failing = async (): Promise<void> => {
      throw new Error('uv sync failed with exit code 2');
    };
    await expect(materializeRuntime(options({ runUv: failing }))).rejects.toThrow('exit code 2');
    expect(readdirSync(runtimeRoot)).toEqual([]);

    // A runtime directory without the marker, e.g. from an interrupted older version.
    mkdirSync(join(runtimeRoot, 'python-abc', 'python'), { recursive: true });
    const calls: string[][] = [];
    await materializeRuntime(options({ runUv: fakeUv('linux', calls) }));
    expect(calls).toHaveLength(2);
    expect(existsSync(join(runtimeRoot, 'python-abc', COMPLETE_MARKER))).toBe(true);
  });

  test('takes over the lock of a dead process', async () => {
    mkdirSync(runtimeRoot, { recursive: true });
    writeFileSync(join(runtimeRoot, 'python-abc.lock'), String(deadPid()));
    await materializeRuntime(options());
    expect(existsSync(join(runtimeRoot, 'python-abc.lock'))).toBe(false);
  });

  test('waits for a live process holding the lock, then uses its runtime', async () => {
    mkdirSync(runtimeRoot, { recursive: true });
    const lock = join(runtimeRoot, 'python-abc.lock');
    writeFileSync(lock, String(process.ppid));
    const statuses: string[] = [];
    const calls: string[][] = [];
    const pending = materializeRuntime(
      options({ runUv: fakeUv('linux', calls), onStatus: (m) => statuses.push(m) }),
    );

    await Bun.sleep(50);
    expect(statuses).toEqual(['Waiting for another GOSAI instance to finish installing Python…']);
    // The other process finishes.
    const other = join(runtimeRoot, 'python-abc');
    mkdirSync(join(other, 'python'), { recursive: true });
    writeFileSync(join(other, COMPLETE_MARKER), '');
    rmSync(lock);

    expect(await pending).toBe(join(other, 'python'));
    expect(calls).toEqual([]);
  });
});

describe('cleanStaleRuntimes', () => {
  test('removes unused runtimes, dead staging dirs and dead locks only', () => {
    const live = process.pid;
    const dead = deadPid();
    const dir = (name: string): string => {
      mkdirSync(join(runtimeRoot, name), { recursive: true });
      return join(runtimeRoot, name);
    };
    dir('python-current');
    writeFileSync(join(dir('python-used'), COMPLETE_MARKER), '');
    mkdirSync(join(runtimeRoot, 'python-used', '.in-use'));
    writeFileSync(join(runtimeRoot, 'python-used', '.in-use', String(live)), '');
    writeFileSync(join(runtimeRoot, 'python-used', '.in-use', String(dead)), '');
    dir('python-unused');
    mkdirSync(join(runtimeRoot, 'python-abandoned', '.in-use'), { recursive: true });
    writeFileSync(join(runtimeRoot, 'python-abandoned', '.in-use', String(dead)), '');
    dir('python-building');
    writeFileSync(join(runtimeRoot, 'python-building.lock'), String(live));
    writeFileSync(join(runtimeRoot, 'python-crashed.lock'), String(dead));
    dir(`.staging-python-new-${live}`);
    dir(`.staging-python-old-${dead}`);
    dir('cpython');

    const removed = cleanStaleRuntimes(runtimeRoot, 'python-current');
    expect(removed.sort()).toEqual(
      ['python-abandoned', 'python-unused', `.staging-python-old-${dead}`].sort(),
    );
    expect(readdirSync(runtimeRoot).sort()).toEqual(
      [
        '.staging-python-new-' + live,
        'cpython',
        'python-building',
        'python-building.lock',
        'python-current',
        'python-used',
      ].sort(),
    );
    // Dead users are pruned from runtimes that stay.
    expect(readdirSync(join(runtimeRoot, 'python-used', '.in-use'))).toEqual([String(live)]);
  });

  test('releaseInUse lets a runtime be cleaned', async () => {
    await materializeRuntime(options({ name: 'python-old' }));
    expect(cleanStaleRuntimes(runtimeRoot, 'python-new')).toEqual([]);
    releaseInUse(join(runtimeRoot, 'python-old'));
    expect(cleanStaleRuntimes(runtimeRoot, 'python-new')).toEqual(['python-old']);
  });
});
