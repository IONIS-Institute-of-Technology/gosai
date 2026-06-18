import { type JSX, useEffect, useState } from 'react';

interface LoadResult {
  status: 'loading' | 'ready' | 'error';
  message?: string;
}

const SERVER_BASE_URL = 'http://127.0.0.1:7777';

export function AppHost(): JSX.Element {
  const [result, setResult] = useState<LoadResult>({ status: 'loading' });

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const appSlug = params.get('app');
    const experienceSlug = params.get('experience');
    const driverBinding = params.get('driverBinding') || undefined;

    if (!appSlug || !experienceSlug) {
      setResult({ status: 'error', message: 'Missing app or experience parameter' });
      return;
    }

    // React StrictMode mounts the effect twice in development, with a
    // cleanup between the two passes. The async setup below races that
    // cleanup, so we guard with a `cancelled` flag: if cleanup fires
    // before `runExperience` resolves we discard the runtime instance
    // immediately, preventing two compositors from being constructed for
    // a single experience start.
    let cancelled = false;
    let runtime: { stop(): Promise<void> } | null = null;

    void (async () => {
      try {
        const sdk = (await import(
          /* @vite-ignore */ `${SERVER_BASE_URL}/sdk-runtime.js`
        )) as typeof import('@gosai/sdk');
        if (cancelled) return;

        const manifestRes = await fetch(`${SERVER_BASE_URL}/v1/apps`);
        if (cancelled) return;
        if (!manifestRes.ok) throw new Error(`Cannot fetch apps list (${manifestRes.status})`);
        const apps = (await manifestRes.json()) as {
          apps: Array<{
            manifest: {
              slug: string;
              experiences: Array<{ slug: string; entry: string }>;
            };
          }>;
        };
        if (cancelled) return;

        const app = apps.apps.find((a) => a.manifest.slug === appSlug);
        if (!app) throw new Error(`App ${appSlug} is not installed`);
        const exp = app.manifest.experiences.find((e) => e.slug === experienceSlug);
        if (!exp) throw new Error(`Experience ${experienceSlug} not declared in ${appSlug}`);

        const entryUrl = `${SERVER_BASE_URL}/v1/apps/${appSlug}/static/${exp.entry}`;
        const expModule = (await import(/* @vite-ignore */ entryUrl)) as {
          default?: import('@gosai/sdk').ExperienceDefinition<unknown>;
        };
        if (cancelled) return;

        if (!expModule.default) {
          throw new Error(`Experience module ${exp.entry} has no default export`);
        }

        const started = await sdk.runExperience(expModule.default, {
          appSlug,
          experienceSlug,
          ...(driverBinding ? { driverBinding } : {}),
          serverBaseUrl: SERVER_BASE_URL,
        });
        if (cancelled) {
          // Cleanup already ran while we were starting; tear down right away.
          void started.stop();
          return;
        }
        runtime = started;
        setResult({ status: 'ready' });
      } catch (err) {
        if (cancelled) return;
        setResult({ status: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    })();

    return () => {
      cancelled = true;
      void runtime?.stop();
    };
  }, []);

  if (result.status === 'error') {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center bg-black p-8 text-center text-red-300">
        <h1 className="font-mono text-lg">GOSAI app failed to start</h1>
        <p className="mt-4 max-w-xl font-mono text-sm text-neutral-300">{result.message}</p>
        <p className="mt-8 font-mono text-xs text-neutral-500">
          Press Cmd/Ctrl+W to close this window.
        </p>
      </div>
    );
  }

  if (result.status === 'loading') {
    return (
      <div className="flex h-full w-full items-center justify-center bg-black text-neutral-400">
        <p className="font-mono text-sm">loading experience…</p>
      </div>
    );
  }

  return <div id="gosai-experience-root" className="h-full w-full bg-black" />;
}
