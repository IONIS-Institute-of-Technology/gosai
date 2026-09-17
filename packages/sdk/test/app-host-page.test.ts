import { describe, expect, test } from 'bun:test';
import { appSlugFromHostname } from '@gosai/shared/app-origin';
import {
  bootAppHost,
  readLaunchParams,
  type AppHostControl,
  type AppHostEnvironment,
} from '../src/app-host-page.js';
import type { RuntimeHandle, RuntimeOptions } from '../src/runtime.js';
import { MANIFEST } from './fakes.js';

describe('app host page', () => {
  test('reads the app slug from the hostname', () => {
    expect(appSlugFromHostname('second-self.localhost')).toBe('second-self');
    expect(appSlugFromHostname('localhost')).toBeNull();
    expect(appSlugFromHostname('127.0.0.1')).toBeNull();
    expect(appSlugFromHostname('a.b.localhost')).toBeNull();
  });

  test('keeps the token out of the params and the cleaned URL', () => {
    const launch = readLaunchParams(
      'http://calibration.localhost:7777/?experience=calibrate&token=app.x.y&role=control&target=pool',
    );
    expect(launch.token).toBe('app.x.y');
    expect(launch.params).toEqual({ experience: 'calibrate', role: 'control', target: 'pool' });
    expect(launch.cleanUrl).toBe(
      'http://calibration.localhost:7777/?experience=calibrate&role=control&target=pool',
    );
  });

  test('works without a token', () => {
    const launch = readLaunchParams('http://demo.localhost:7777/');
    expect(launch.token).toBeNull();
    expect(launch.params).toEqual({});
  });
});

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function fakeHandle(): RuntimeHandle & { stops: number } {
  const handle = {
    stops: 0,
    context: {} as RuntimeHandle['context'],
    server: {} as RuntimeHandle['server'],
    stop: async () => void (handle.stops += 1),
  };
  return handle;
}

function hostEnvironment(overrides: Partial<AppHostEnvironment> = {}) {
  const storage = new Map<string, string>();
  const errors: string[] = [];
  const urls: string[] = [];
  const window = new EventTarget();
  const env: AppHostEnvironment = {
    location: new URL('http://demo.localhost:7777/?experience=main&token=app.demo.sig&role=x'),
    window,
    sessionStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => void storage.set(key, value),
    },
    replaceUrl: (url) => void urls.push(url),
    fetch: async () => Response.json(MANIFEST),
    importModule: async () => ({ default: { start: () => undefined } }),
    runExperience: async () => fakeHandle(),
    setTitle: () => undefined,
    showError: (title) => void errors.push(title),
    ...overrides,
  };
  const control = (): AppHostControl =>
    (window as unknown as { gosaiHost: AppHostControl }).gosaiHost;
  return { env, storage, errors, urls, control, window };
}

describe('bootAppHost', () => {
  test('runs the experience with the token, params and origin, and strips the token', async () => {
    let options: RuntimeOptions | null = null;
    const { env, storage, urls, errors } = hostEnvironment({
      runExperience: async (_definition, opts) => {
        options = opts;
        return fakeHandle();
      },
    });
    await bootAppHost(env);
    expect(errors).toEqual([]);
    expect(options).toMatchObject({
      appSlug: 'demo',
      experienceSlug: 'main',
      serverBaseUrl: 'http://demo.localhost:7777',
      authToken: 'app.demo.sig',
      params: { experience: 'main', role: 'x' },
    });
    expect(storage.get('gosai:token')).toBe('app.demo.sig');
    expect(urls).toEqual(['http://demo.localhost:7777/?experience=main&role=x']);
  });

  test('stop while the entry is importing cancels without running or showing an error', async () => {
    const importing = deferred<{ default?: unknown }>();
    let ran = false;
    const { env, errors, control } = hostEnvironment({
      importModule: () => importing.promise,
      runExperience: async () => {
        ran = true;
        return fakeHandle();
      },
    });
    const booted = bootAppHost(env);
    await flush();
    const stopped = control().stop();
    importing.resolve({ default: {} });
    await Promise.all([booted, stopped]);
    expect(ran).toBe(false);
    expect(errors).toEqual([]);
  });

  test('stop while the runtime starts waits for it, then stops the handle', async () => {
    const starting = deferred<RuntimeHandle>();
    let signal: AbortSignal | undefined;
    const handle = fakeHandle();
    const { env, control } = hostEnvironment({
      runExperience: (_definition, opts) => {
        signal = opts.signal;
        return starting.promise;
      },
    });
    const booted = bootAppHost(env);
    await flush();
    let stopDone = false;
    const stopped = control()
      .stop()
      .then(() => (stopDone = true));
    await flush();
    expect(signal?.aborted).toBe(true);
    expect(stopDone).toBe(false);
    starting.resolve(handle);
    await Promise.all([booted, stopped]);
    expect(handle.stops).toBe(1);
  });

  test('pagehide stops the experience', async () => {
    const handle = fakeHandle();
    const { env, window } = hostEnvironment({ runExperience: async () => handle });
    await bootAppHost(env);
    window.dispatchEvent(new Event('pagehide'));
    await flush();
    expect(handle.stops).toBe(1);
  });

  test('shows an error for a missing app or a module without a definition', async () => {
    const missing = hostEnvironment({
      fetch: async () => Response.json({ error: 'app demo is not installed' }, { status: 404 }),
    });
    await bootAppHost(missing.env);
    expect(missing.errors).toEqual(['The experience failed to start']);

    const badModule = hostEnvironment({ importModule: async () => ({ default: 42 }) });
    await bootAppHost(badModule.env);
    expect(badModule.errors).toEqual(['The experience failed to start']);
  });
});
