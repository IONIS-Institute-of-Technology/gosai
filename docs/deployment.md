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

1. Electron's main process materialises the Python runtime on first launch
   (see the kiosk section below - the same bootstrap runs for the regular
   desktop when `uv` is available), then spawns the embedded `gosai-server`
   binary as a child process (`ServerRunner.start()`).
2. The dashboard connects over WebSocket on `127.0.0.1:7777` and shows the
   list of built-in + installed apps.

## Kiosk bundles (one executable per app)

`bun run package:kiosk -- <app-dir>` produces a self-contained bundle that
boots straight into a single app - intended for kiosk deployments on clean
machines:

```bash
bun run package:kiosk -- apps/interactive-pool            # Linux AppImage (default)
bun run package:kiosk -- apps/interactive-pool --macos    # macOS DMG
```

Options: `--experience <slug>` (default: the manifest's `default`),
`--display <index>` (default: primary), `--python-extras <list>` (extra
Python dependency groups such as `speech,realsense`), `--windowed`,
`--skip-build`.

The bundle contains the same runtime as the regular desktop package
(Electron shell, compiled `gosai-server`, Python tree) plus:

- `Resources/apps/<slug>/` - only the packaged app.
- `Resources/kiosk.json` - tells the shell to boot into this app.
- `Resources/bin/uv` - the `uv` binary for the target platform, used to
  build the Python environment on first launch.

At launch the shell:

1. Creates an isolated data directory at `~/.gosai-kiosks/<slug>` (override
   with `GOSAI_HOME`) holding config, storage, logs, and the Electron
   profile - so kiosks never share state with each other or with a regular
   GOSAI install.
2. **First launch only:** materialises the Python runtime under
   `~/.gosai-runtime/python-<hash>/` with the bundled `uv` - downloading a
   managed CPython 3.12 and installing all base dependencies, which include
   the full CV stack (OpenCV, MediaPipe, ONNX Runtime), so the camera /
   pose / hand_pose / ball drivers work out of the box. A status window
   shows progress; this step needs internet access once. The runtime is
   keyed by a hash of `pyproject.toml` + `uv.lock` + extras, so kiosks with
   identical requirements share one installation.
3. Starts the embedded server on an **ephemeral port** (`GOSAI_PORT=0`; the
   OS picks a free one), so any number of kiosks can run side by side with
   no port configuration. The chosen port is written to
   `<home>/server-info.json`.
4. Starts the app's experience and opens it fullscreen on the primary
   display (or the display index baked in at packaging time).

Closing the window quits the kiosk. Artifacts land in
`packages/desktop/release/kiosk/<slug>/`.

### Running and configuring on the kiosk machine

```bash
chmod +x Second\ Self-kiosk-1.0.0-linux-x86_64.AppImage
./Second\ Self-kiosk-1.0.0-linux-x86_64.AppImage
```

Environment variables override the packaged defaults at launch, so a
deployed kiosk can be re-pointed without rebuilding:

| Variable                    | Effect                                        |
| --------------------------- | --------------------------------------------- |
| `GOSAI_HOME`                | Data directory (default `~/.gosai-kiosks/<slug>`) |
| `GOSAI_KIOSK_DISPLAY`       | Display index (0-based)                       |
| `GOSAI_KIOSK_EXPERIENCE`    | Experience slug to boot                       |
| `GOSAI_KIOSK_WINDOWED=1`    | Window instead of fullscreen                  |
| `GOSAI_KIOSK_PYTHON_EXTRAS` | Comma-separated Python extras                 |

Device assignments (which camera / microphone / resolution the app uses)
live in `<home>/apps/<slug>/_config/settings.json` and persist across
launches. App key/value storage (calibration profiles, ...) is under
`<home>/apps/<slug>/_data/`; logs under `<home>/logs/`.

For unattended operation, a systemd user unit keeps the kiosk alive:

```ini
# ~/.config/systemd/user/gosai-kiosk.service
[Unit]
Description=GOSAI kiosk
After=graphical-session.target

[Service]
ExecStart=/opt/gosai/second-self.AppImage
Environment=GOSAI_KIOSK_DISPLAY=0
Restart=always
RestartSec=3

[Install]
WantedBy=graphical-session.target
```

```bash
systemctl --user enable --now gosai-kiosk
```

The regular packaged desktop performs the same first-run Python bootstrap
when a `uv` binary is available (bundled under `Resources/bin` or already on
`PATH`).

### Running kiosks without a per-app bundle

The same kiosk mode works with a shared runtime. Either from the repo:

```bash
bun run kiosk /path/to/built-app --display 1
```

or against an installed GOSAI package:

```bash
GOSAI_DESKTOP_BIN=/Applications/GOSAI.app/Contents/MacOS/GOSAI \
  bun run kiosk /path/to/built-app
```

`bun run kiosk` wraps the desktop shell's `--kiosk <app-dir>` flag; each
invocation gets its own data directory and port exactly like a packaged
kiosk.

## Troubleshooting

| Symptom                                         | Likely cause                                                        |
| ----------------------------------------------- | ------------------------------------------------------------------- |
| "Address already in use" on startup             | Another process holds port 7777. Set `GOSAI_PORT=<free>` and retry. |
| "no server binary found; skipping autostart"    | The `Resources/server/gosai-server` blob is missing from the build. |
| Python drivers don't start                      | `.venv` failed to build. Inspect logs in `~/Library/Logs/GOSAI/`.   |
| App install fails with "git: command not found" | `git` is not in PATH for the GUI process.                           |
