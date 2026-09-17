import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appEnvPython,
  appPythonEnvDir,
  buildAppPythonEnv,
  ensureAppPythonEnv,
  type AppEnvOptions,
} from '../src/apps/python-env.js';
import { Logger } from '../src/logger/logger.js';
import {
  fakeToolchain,
  HAS_PYTHON_ENV,
  HAS_UV,
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
