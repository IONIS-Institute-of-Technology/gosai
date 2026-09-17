import { describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appDriversDir,
  appEnvPython,
  appPythonEnvDir,
  buildAppPythonEnv,
  checkRequirements,
  ensureAppPythonEnv,
  type AppEnvOptions,
} from '../src/apps/python-env.js';
import { Logger } from '../src/logger/logger.js';
import {
  fakeToolchain,
  HAS_PYTHON_ENV,
  HAS_UV,
  processRuns,
  REPO_PYTHON_DIR,
  writeDriverPackage,
  writeTinyWheel,
} from './python-fixtures.js';

const logger = new Logger({ logsDir: mkdtempSync(join(tmpdir(), 'gosai-python-env-logs-')) });

function setup(requirements: string | null = 'requirements.txt') {
  const root = mkdtempSync(join(tmpdir(), 'gosai-python-env-'));
  const fake = fakeToolchain(root);
  const appDir = join(root, 'app');
  const python = writeDriverPackage(appDir, { 'counter.py': '' });
  if (requirements) writeFileSync(join(appDir, requirements), 'tinydep\n');
  const options: AppEnvOptions = {
    toolchain: fake.toolchain,
    envDir: appPythonEnvDir({ root }, 'installed', 'hello-app'),
    appDir,
    python: requirements ? { ...python, requirements } : python,
    logger: logger.child('env'),
    platform: 'linux',
  };
  return { root, fake, appDir, options };
}

describe('app python environments', () => {
  test('layers a venv on the base environment and pins the base packages', async () => {
    const { root, fake, appDir, options } = setup();

    const python = await buildAppPythonEnv(options);

    const envDir = join(root, 'python-envs', 'installed', 'hello-app');
    expect(python).toBe(join(envDir, '.venv', 'bin', 'python'));
    const basePython = join(fake.toolchain.pythonDir, '.venv', 'bin', 'python');
    const constraints = join(envDir, 'constraints.txt');
    expect(fake.calls()).toEqual([
      `venv --no-project --python ${basePython} ${join(envDir, '.venv')}`,
      `pip install --python ${python} -r ${join(appDir, 'requirements.txt')} -c ${constraints}`,
    ]);
    // gosai-py comes from the base environment and is never a constraint.
    expect(readFileSync(constraints, 'utf8')).toBe('numpy==2.3.1\n');
    const pth = readFileSync(
      join(envDir, '.venv', 'lib', 'python3.12', 'site-packages', '_gosai_base.pth'),
      'utf8',
    );
    const baseSite = join(fake.toolchain.pythonDir, '.venv', 'lib', 'python3.12', 'site-packages');
    expect(pth).toBe(`import site; site.addsitedir(${JSON.stringify(baseSite)})\n`);
  });

  test('skips uv pip without a requirements file', async () => {
    const { fake, options } = setup(null);
    await buildAppPythonEnv(options);
    expect(fake.calls().map((call) => call.split(' ')[0])).toEqual(['venv']);
  });

  test('rebuilds only when the requirements or the base environment change', async () => {
    const { fake, appDir, options } = setup();
    await ensureAppPythonEnv(options);
    await ensureAppPythonEnv(options);
    expect(fake.calls()).toHaveLength(2);

    writeFileSync(join(appDir, 'requirements.txt'), 'tinydep==0.1.0\n');
    await ensureAppPythonEnv(options);
    expect(fake.calls()).toHaveLength(4);

    fake.addBasePackage('opencv_python-5.0.0.dist-info');
    await ensureAppPythonEnv(options);
    expect(fake.calls()).toHaveLength(6);
    await ensureAppPythonEnv(options);
    expect(fake.calls()).toHaveLength(6);
  });

  test('a failed install removes the environment and reports uv output', async () => {
    const { fake, options } = setup();
    fake.failPipInstall(true);
    await expect(buildAppPythonEnv(options)).rejects.toThrow(
      /uv pip install failed \(exit 1\)[\s\S]*conflicts with numpy==2\.3\.1/,
    );
    expect(existsSync(options.envDir)).toBe(false);
  });

  test('refuses a missing driver package, requirements file or uv', async () => {
    const { options } = setup();
    await expect(
      buildAppPythonEnv({ ...options, python: { drivers: 'python/missing' } }),
    ).rejects.toThrow('python.drivers python/missing does not exist');
    await expect(
      buildAppPythonEnv({
        ...options,
        python: { ...options.python, requirements: 'nope.txt' },
      }),
    ).rejects.toThrow('python.requirements nope.txt does not exist');
    await expect(
      buildAppPythonEnv({ ...options, toolchain: { ...options.toolchain, uv: '/no/uv' } }),
    ).rejects.toThrow('uv was not found at /no/uv');
  });

  test.skipIf(process.platform === 'win32')(
    'aborting kills uv and the processes it started, and removes the environment',
    async () => {
      const { fake, options } = setup();
      fake.hangPipInstall(true);
      const controller = new AbortController();
      const build = ensureAppPythonEnv({ ...options, signal: controller.signal });
      const deadline = Date.now() + 5_000;
      while (
        !existsSync(fake.pidFile) ||
        readFileSync(fake.pidFile, 'utf8').split('\n').length < 3
      ) {
        if (Date.now() > deadline) throw new Error('uv pip install did not start');
        await Bun.sleep(10);
      }
      const pids = readFileSync(fake.pidFile, 'utf8').trim().split('\n').map(Number);

      const started = Date.now();
      controller.abort();
      await expect(build).rejects.toThrow('uv pip install was cancelled');
      expect(Date.now() - started).toBeLessThan(3_000);
      expect(existsSync(options.envDir)).toBe(false);
      for (const pid of pids) expect({ pid, runs: processRuns(pid) }).toEqual({ pid, runs: false });

      // An aborted signal never starts a build.
      await expect(ensureAppPythonEnv({ ...options, signal: controller.signal })).rejects.toThrow();
      expect(fake.calls().filter((call) => call.startsWith('venv'))).toHaveLength(1);
    },
  );

  test('refuses editable local requirements, also in included files', () => {
    const root = mkdtempSync(join(tmpdir(), 'gosai-requirements-'));
    const file = (name: string, text: string): string => {
      const path = join(root, name);
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, text);
      return path;
    };
    const fine = file(
      'fine.txt',
      '# comment -e ./nope\ntinydep\n./python/localpkg\n-e git+https://example.com/pkg.git#egg=pkg\n',
    );
    expect(() => checkRequirements(root, fine)).not.toThrow();
    for (const line of [
      '-e ./python/localpkg',
      '--editable=python/localpkg',
      '-e file:///abs/pkg',
    ]) {
      const path = file('editable.txt', `tinydep\n${line}\n`);
      expect(() => checkRequirements(root, path)).toThrow(
        `editable.txt:2: editable local requirements such as "${line}" are not supported`,
      );
    }
    file('python/more.txt', '-e .\n');
    const nested = file('nested.txt', '-r python/more.txt\n');
    expect(() => checkRequirements(root, nested)).toThrow('more.txt:1: editable local');
    // Including each other doesn't loop.
    file('a.txt', '-r b.txt\n');
    const b = file('b.txt', '-r a.txt\n');
    expect(() => checkRequirements(root, b)).not.toThrow();
  });

  test('a build refuses editable requirements before running uv', async () => {
    const { fake, appDir, options } = setup();
    writeFileSync(join(appDir, 'requirements.txt'), '-e ./python/test_drivers\n');
    await expect(buildAppPythonEnv(options)).rejects.toThrow('editable local requirements');
    expect(fake.calls()).toEqual([]);
  });

  test('driver and requirement paths may not leave the app through a symlink', async () => {
    const { root, appDir, options } = setup();
    mkdirSync(join(root, 'outside'));
    writeFileSync(join(root, 'outside', 'requirements.txt'), 'tinydep\n');
    symlinkSync(join(root, 'outside'), join(appDir, 'linked'));
    expect(() => appDriversDir(appDir, { drivers: 'linked' })).toThrow('linked is outside the app');
    await expect(
      buildAppPythonEnv({
        ...options,
        python: { ...options.python, requirements: 'linked/requirements.txt' },
      }),
    ).rejects.toThrow('linked/requirements.txt is outside the app');
    // A symlink that stays inside is fine.
    symlinkSync(join(appDir, 'python', 'test_drivers'), join(appDir, 'alias'));
    expect(appDriversDir(appDir, { drivers: 'alias' })).toBe(
      join(realpathSync(appDir), 'python', 'test_drivers'),
    );
  });

  test.skipIf(!HAS_PYTHON_ENV || !HAS_UV)(
    'real uv installs a local wheel and gosai_py stays importable',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'gosai-python-env-real-'));
      const appDir = join(root, 'app');
      const python = writeDriverPackage(appDir, { 'counter.py': '' });
      const wheel = writeTinyWheel(join(appDir, 'vendor'));
      writeFileSync(join(appDir, 'requirements.txt'), `${wheel}\n`);
      const envDir = appPythonEnvDir({ root }, 'builtin', 'hello-app');

      const interpreter = await ensureAppPythonEnv({
        toolchain: { pythonDir: REPO_PYTHON_DIR, uv: 'uv' },
        envDir,
        appDir,
        python: { ...python, requirements: 'requirements.txt' },
        logger: logger.child('env'),
        timeoutMs: 120_000,
      });

      expect(interpreter).toBe(appEnvPython(envDir));
      const run = Bun.spawnSync({
        cmd: [interpreter, '-P', '-c', 'import gosai_py, msgspec, tinydep; print(tinydep.VALUE)'],
      });
      expect(run.stderr.toString()).toBe('');
      expect(run.stdout.toString().trim()).toBe('42');
    },
    180_000,
  );
});
