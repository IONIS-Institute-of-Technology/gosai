import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
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
  isProcessAlive,
  LAST_USED,
  LOCK_STALE_MS,
  markInUse,
  materializeRuntime,
  pythonVersionFromPyproject,
  readPythonRuntimeInfo,
  releaseInUse,
  runtimeName,
  type MaterializeOptions,
  type ProcessProbe,
} from '../src/main/python-runtime.js';

const DAY = 24 * 60 * 60 * 1000;
const BOOT = Date.now() - 3 * DAY;

let root: string;
let source: string;
let runtimeRoot: string;
let now: number;

const probe: ProcessProbe = { isAlive: isProcessAlive, bootTime: BOOT, now: () => now };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gosai-python-runtime-'));
  source = join(root, 'resources', 'python');
  runtimeRoot = join(root, 'runtime');
  now = Date.now();
  mkdirSync(join(source, 'src', 'gosai_py'), { recursive: true });
  writeFileSync(join(source, 'pyproject.toml'), '[project]\nrequires-python = ">=3.12"\n');
  writeFileSync(join(source, 'uv.lock'), 'lock');
  writeFileSync(join(source, 'src', 'gosai_py', 'bridge.py'), 'print("hi")');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeLock(name: string, pid: number, bootTime = BOOT): string {
  mkdirSync(runtimeRoot, { recursive: true });
  const path = join(runtimeRoot, `${name}.lock`);
  writeFileSync(path, JSON.stringify({ pid, bootTime, token: `token-${pid}` }));
  return path;
}

/** A complete runtime of `family`, last used `lastUsed` ms ago. */
function writeRuntime(name: string, family: string, lastUsed = 0): string {
  const dir = join(runtimeRoot, name);
  mkdirSync(join(dir, 'python'), { recursive: true });
  writeFileSync(join(dir, COMPLETE_MARKER), JSON.stringify({ family }));
  writeFileSync(join(dir, LAST_USED), String(now - lastUsed));
  return dir;
}

function backdate(path: string, ms: number): void {
  const time = new Date(Date.now() - ms);
  utimesSync(path, time, time);
}

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
    family: 'GOSAI\n',
    commands: [['venv'], ['sync']],
    runUv: fakeUv(),
    probe,
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
  test('ignore venvs, caches and tests but see source changes', () => {
    const before = hashPythonTree(source);
    mkdirSync(join(source, 'tests', 'data'), { recursive: true });
    writeFileSync(join(source, 'tests', 'data', 'clip.wav'), 'x');
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
    expect(JSON.parse(readFileSync(join(finalDir, COMPLETE_MARKER), 'utf8')).family).toBe(
      'GOSAI\n',
    );
    expect(readFileSync(join(finalDir, LAST_USED), 'utf8').trim()).toBe(String(now));
    expect(existsSync(join(pythonDir, 'src', 'gosai_py', 'bridge.py'))).toBe(true);
    expect(readdirSync(join(runtimeRoot, '.in-use', 'python-abc'))).toEqual(['42']);
    expect(readdirSync(runtimeRoot).sort()).toEqual(['.in-use', 'python-abc']);

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
    expect(readdirSync(runtimeRoot)).toEqual(['.in-use']);
    expect(readdirSync(join(runtimeRoot, '.in-use'))).toEqual([]);

    // A runtime directory without the marker, e.g. from a manual edit.
    mkdirSync(join(runtimeRoot, 'python-abc', 'python'), { recursive: true });
    const calls: string[][] = [];
    await materializeRuntime(options({ runUv: fakeUv('linux', calls) }));
    expect(calls).toHaveLength(2);
    expect(existsSync(join(runtimeRoot, 'python-abc', COMPLETE_MARKER))).toBe(true);
  });

  test('never replaces a runtime another builder completed meanwhile', async () => {
    const racing = async (args: readonly string[], cwd: string): Promise<void> => {
      await fakeUv()(args, cwd);
      writeRuntime('python-abc', 'other builder');
    };
    const pythonDir = await materializeRuntime(options({ runUv: racing }));
    expect(pythonDir).toBe(join(runtimeRoot, 'python-abc', 'python'));
    const marker = readFileSync(join(runtimeRoot, 'python-abc', COMPLETE_MARKER), 'utf8');
    expect(JSON.parse(marker).family).toBe('other builder');
    expect(readdirSync(runtimeRoot).filter((entry) => entry.startsWith('.staging'))).toEqual([]);
  });

  test('takes over the lock of a dead process', async () => {
    const lock = writeLock('python-abc', deadPid());
    await materializeRuntime(options());
    expect(existsSync(lock)).toBe(false);
  });

  test('takes over a lock from a previous boot even when its pid runs again', async () => {
    // Power cut mid-install; after the reboot another process got that pid.
    const lock = writeLock('python-abc', process.ppid, BOOT - DAY);
    const calls: string[][] = [];
    await materializeRuntime(options({ runUv: fakeUv('linux', calls) }));
    expect(calls).toHaveLength(2);
    expect(existsSync(lock)).toBe(false);
  });

  test('takes over a lock its live holder stopped refreshing', async () => {
    const lock = writeLock('python-abc', process.ppid);
    backdate(lock, LOCK_STALE_MS + 1000);
    const calls: string[][] = [];
    await materializeRuntime(options({ runUv: fakeUv('linux', calls) }));
    expect(calls).toHaveLength(2);
  });

  test('refreshes its own lock during a long install', async () => {
    const lock = join(runtimeRoot, 'python-abc.lock');
    const slow = async (args: readonly string[], cwd: string): Promise<void> => {
      backdate(lock, 60_000);
      const before = statSync(lock).mtimeMs;
      await Bun.sleep(60);
      expect(statSync(lock).mtimeMs).toBeGreaterThan(before);
      await fakeUv()(args, cwd);
    };
    await materializeRuntime(options({ runUv: slow, lockHeartbeatMs: 10 }));
  });

  test('waits for a live process holding the lock, then uses its runtime', async () => {
    const lock = writeLock('python-abc', process.ppid);
    const statuses: string[] = [];
    const calls: string[][] = [];
    const pending = materializeRuntime(
      options({ runUv: fakeUv('linux', calls), onStatus: (m) => statuses.push(m) }),
    );

    await Bun.sleep(50);
    expect(statuses).toEqual(['Waiting for another GOSAI instance to finish installing Python…']);
    // The other process finishes.
    writeRuntime('python-abc', 'GOSAI\n');
    rmSync(lock);

    expect(await pending).toBe(join(runtimeRoot, 'python-abc', 'python'));
    expect(calls).toEqual([]);
  });
});

describe('cleanStaleRuntimes', () => {
  const desktop = 'GOSAI\n';
  const speechKiosk = 'Pool\nspeech';

  test('replaces older runtimes of the same family and keeps other extras for 30 days', () => {
    writeRuntime('python-new', desktop);
    writeRuntime('python-old', desktop, DAY);
    writeRuntime('python-speech', speechKiosk, 29 * DAY);
    writeRuntime('python-plain', 'Pool\n', 2 * DAY);

    const clean = (): string[] =>
      cleanStaleRuntimes({ runtimeRoot, keep: 'python-new', family: desktop, probe }).sort();
    expect(clean()).toEqual(['python-old']);
    expect(existsSync(join(runtimeRoot, 'python-speech'))).toBe(true);
    expect(existsSync(join(runtimeRoot, 'python-plain'))).toBe(true);

    // The speech kiosk launches again: its runtime stays, the desktop's goes.
    now += 2 * DAY;
    expect(
      cleanStaleRuntimes({ runtimeRoot, keep: 'python-speech', family: speechKiosk, probe }),
    ).toEqual([]);
    writeFileSync(join(runtimeRoot, 'python-speech', LAST_USED), String(now));

    now += 29 * DAY;
    expect(clean()).toEqual(['python-plain']);
    now += 2 * DAY;
    expect(clean()).toEqual(['python-speech']);
  });

  test('keeps runtimes with live users or builders and forgets dead ones', () => {
    writeRuntime('python-keep', desktop);
    writeRuntime('python-used', desktop);
    writeRuntime('python-previous-boot', desktop);
    writeRuntime('python-building', desktop);
    markInUse(runtimeRoot, 'python-used', { pid: process.pid, bootTime: BOOT + 5000 });
    markInUse(runtimeRoot, 'python-used', { pid: deadPid(), bootTime: BOOT });
    markInUse(runtimeRoot, 'python-previous-boot', { pid: process.pid, bootTime: BOOT - DAY });
    markInUse(runtimeRoot, 'python-keep', { pid: deadPid(), bootTime: BOOT });
    writeLock('python-building', process.pid);

    const removed = cleanStaleRuntimes({
      runtimeRoot,
      keep: 'python-keep',
      family: desktop,
      probe,
    });
    expect(removed).toEqual(['python-previous-boot']);
    expect(readdirSync(join(runtimeRoot, '.in-use', 'python-used'))).toEqual([String(process.pid)]);
    expect(existsSync(join(runtimeRoot, '.in-use', 'python-keep'))).toBe(false);
    expect(existsSync(join(runtimeRoot, '.in-use', 'python-previous-boot'))).toBe(false);
  });

  test('removes leftovers of dead processes only', () => {
    mkdirSync(join(runtimeRoot, '.staging-python-live-1'), { recursive: true });
    mkdirSync(join(runtimeRoot, '.staging-python-dead-2'), { recursive: true });
    writeLock('python-live', process.pid);
    const deadLock = writeLock('python-dead', process.pid, BOOT - DAY);
    mkdirSync(join(runtimeRoot, `.trash-python-x-${now - 120_000}-ab`));
    mkdirSync(join(runtimeRoot, `.trash-python-y-${now}-cd`));
    mkdirSync(join(runtimeRoot, 'cpython'));

    cleanStaleRuntimes({ runtimeRoot, keep: 'python-keep', family: desktop, probe });
    expect(readdirSync(runtimeRoot).sort()).toEqual(
      ['.staging-python-live-1', `.trash-python-y-${now}-cd`, 'cpython', 'python-live.lock'].sort(),
    );
    expect(existsSync(deadLock)).toBe(false);
  });

  test('gives a runtime back when a process registers while it is being deleted', () => {
    writeRuntime('python-new', desktop);
    writeRuntime('python-old', desktop);
    // Runs between the first look for users and the rename to trash.
    let registered = false;
    const racingProbe: ProcessProbe = {
      ...probe,
      now: () => {
        if (!registered) {
          registered = true;
          markInUse(runtimeRoot, 'python-old', { pid: process.pid, bootTime: BOOT });
        }
        return now;
      },
    };
    expect(
      cleanStaleRuntimes({ runtimeRoot, keep: 'python-new', family: desktop, probe: racingProbe }),
    ).toEqual([]);
    expect(isCompleteDir(join(runtimeRoot, 'python-old'))).toBe(true);
    expect(readdirSync(runtimeRoot).filter((entry) => entry.startsWith('.trash'))).toEqual([]);
  });

  test('a released runtime can be cleaned', async () => {
    await materializeRuntime(options({ name: 'python-old' }));
    writeRuntime('python-new', desktop);
    const clean = (): string[] =>
      cleanStaleRuntimes({ runtimeRoot, keep: 'python-new', family: desktop, probe });
    expect(clean()).toEqual([]);
    releaseInUse(runtimeRoot, 'python-old');
    expect(clean()).toEqual(['python-old']);
  });
});

function isCompleteDir(dir: string): boolean {
  return existsSync(join(dir, COMPLETE_MARKER));
}
