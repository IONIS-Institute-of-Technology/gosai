# Deployment & Packaging

The GOSAI desktop app ships as a self-contained installer that bundles:

- The Electron renderer + main bundle (built by `electron-vite`).
- A single-file GOSAI server compiled by `bun build --compile`.
- The Python source tree under `Contents/Resources/python/`. The packaged
  app creates `.venv` on first run via `uv sync`.
- The built-in apps under `Contents/Resources/apps/`.
- The SDK runtime bundle served to app-host windows at `/sdk-runtime.js`.

## Producing a macOS DMG

```bash
bun install                  # pulls electron-builder
bun run package:mac          # see the targets below
```

`package:mac` is shorthand for:

```bash
bun run build                # @gosai/{shared,server,sdk,desktop} build
bun run build:apps           # built-in app(s) + template
bun run build:server-bin     # compiles the server to a single binary
bun --filter @gosai/desktop run dist:mac
```

The DMG lands at `packages/desktop/release/GOSAI-*.dmg`.

> The default config disables hardened runtime and code signing so the
> output is unsigned. For a notarised build, set
> `CSC_LINK`/`CSC_KEY_PASSWORD` and `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`
> environment variables and toggle `hardenedRuntime: true` in
> `packages/desktop/electron-builder.config.cjs`.

## Producing a Linux AppImage

```bash
bun run package:linux
```

Output: `packages/desktop/release/GOSAI-*-linux-x64.AppImage`.

The AppImage embeds the same server binary, Python sources, and built-in
apps. The runtime user only needs `git` available on `PATH` for installing
new apps via the dashboard.

## First-run behaviour

When the packaged app launches:

1. Electron's main process spawns the embedded `gosai-server` binary as a
   child process (`ServerRunner.start()`).
2. The server discovers the Python tree at `Contents/Resources/python/` and
   runs `uv sync` if `.venv/bin/gosai-bridge` is missing. (Apps that depend
   on optional extras like `cv` / `speech` should declare them in their own
   `gosai.app.json -> python.requirements`.)
3. The dashboard connects over WebSocket on `127.0.0.1:7777` and shows the
   list of built-in + installed apps.

## Troubleshooting

| Symptom                                       | Likely cause                                                        |
| --------------------------------------------- | ------------------------------------------------------------------- |
| "Address already in use" on startup           | Another process holds port 7777. Set `GOSAI_PORT=<free>` and retry. |
| "no server binary found; skipping autostart"  | The `Resources/server/gosai-server` blob is missing from the build. |
| Python drivers don't start                    | `.venv` failed to build. Inspect logs in `~/Library/Logs/GOSAI/`.   |
| App install fails with "git: command not found" | `git` is not in PATH for the GUI process.                          |
