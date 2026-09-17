# Deployment & Packaging

The GOSAI desktop app ships as a self-contained package that bundles:

- The Electron main, preload and renderer bundles (built by `electron-vite`).
- A single-file GOSAI server compiled by `bun build --compile`.
- `uv`, which builds the Python environment on first launch.
- The Python source tree under `resources/python/`.
- The built-in apps under `resources/apps/`.
- The SDK bundle served to app windows under `/sdk/<version>/`.

Supported targets are Linux x64 and macOS arm64. Windows x64 builds are best
effort.

## Producing packages

```bash
bun install                  # pulls electron-builder
bun run package:linux        # Linux x64 AppImage
bun run package:mac          # macOS arm64 DMG, on a Mac
bun run package:win          # Windows x64 installer, best effort
```

`package:linux` is shorthand for:

```bash
bun run build                # @gosai/{shared,server,sdk,desktop} build
bun run build:apps           # built-in apps
bun run --filter @gosai/desktop dist:linux
```

`dist:linux` builds the desktop bundles, runs
`bun scripts/prepare-bundle.ts --target linux-x64` and then electron-builder.
The prepare step writes `packages/desktop/release/bundle/`:

- `<target>/server/gosai-server`: the server, cross-compiled for the target
  with `bun build --compile --target`, so any host can build it.
- `<target>/bin/uv`: the pinned uv release from `scripts/fetch-uv.ts`,
  checked against the sha256 published with that release. Verified archives
  are cached per version under `packages/desktop/release/cache/`.
- `python-runtime.json`: a hash of the Python tree and the Python version
  from `requires-python` in `python/pyproject.toml`. The packaged app keys
  its Python runtime on them without hashing the tree at each launch.

The server and uv are prepared for any target from any host, but
electron-builder only makes a DMG on macOS. The `Release` GitHub workflow builds all
three on tags and manual runs and keeps the files as workflow artifacts.

Outputs:

- `packages/desktop/release/GOSAI-<version>-linux-x86_64.AppImage`
- `packages/desktop/release/GOSAI-<version>-mac-arm64.dmg`
- `packages/desktop/release/GOSAI-<version>-win-x64.exe`

The runtime user only needs `git` on `PATH` to install apps from the
dashboard. uv and Python come with the package.

### macOS signing

The DMG is signed ad hoc (`mac.identity: '-'`) without a hardened runtime.
It is not notarized, so macOS quarantines it when downloaded and Gatekeeper
refuses to open it. After copying GOSAI to Applications, clear the
quarantine flag once:

```bash
xattr -dr com.apple.quarantine /Applications/GOSAI.app
```

A notarized build needs a Developer ID certificate (`CSC_LINK` and
`CSC_KEY_PASSWORD`, replacing `identity: '-'`), notarization credentials
(`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID`), and
`hardenedRuntime: true`. Under a hardened runtime the bun-compiled
`resources/server/gosai-server` needs the
`com.apple.security.cs.allow-jit` and
`com.apple.security.cs.allow-unsigned-executable-memory` entitlements, in
`entitlements` and `entitlementsInherit` (it is a child process), or it
fails to start.

## First-run behaviour

When the packaged app launches, desktop and kiosk alike:

1. It takes a single-instance lock on its Electron profile. A second launch
   of the desktop app focuses the running dashboard and exits.
2. A status window shows progress while the Python runtime is prepared. The
   first launch copies the Python tree to
   `~/.gosai-runtime/python-<key>/` and runs the bundled `uv`, which
   downloads a managed CPython and installs the base dependencies, including
   the CV stack (OpenCV, MediaPipe, ONNX Runtime). On Linux x64 with an
   NVIDIA driver 580 or newer, it installs the `gpu` extra (CUDA
   onnxruntime) instead of the CPU build. This step needs internet access
   once. `<key>` covers the Python tree hash, the Python version and the
   extras, so packages with identical requirements share one installation.
   The install runs in a staging directory under a lock file and is renamed
   into place with a `.complete` marker once it finished, so an interrupted
   install is redone and two instances never install at once. A lock whose
   holder died, or was held before a reboot, or stopped being refreshed for
   two minutes, is taken over. A runtime that no running GOSAI uses is
   deleted when a newer runtime for the same app and extras is ready (after
   an upgrade), or when no launch used it for 30 days. Runtimes of other
   apps or other extras stay until then.
3. It starts the embedded server on `127.0.0.1` with an ephemeral port (the
   OS picks a free one) and hands that port to its windows. The server
   prints the port on its `GOSAI_READY` line.
4. The dashboard (or, in a kiosk, the app) opens.

If the Python runtime can't be installed, GOSAI still starts and says so: a
warning dialog on the desktop, a message on the status window for a few
seconds in a kiosk. Apps without Python drivers keep working. If the server
can't start, the desktop shows an error dialog and a kiosk shows the error
for 15 seconds, then both exit with code 1.

The server watches a pipe from the desktop app. When the app exits for any
reason, including a crash, the server stops its Python bridge and exits, so
nothing keeps running in the background.

## Kiosk bundles (one executable per app)

`bun run package:kiosk -- <app-dir>` produces a self-contained bundle that
boots straight into a single app, intended for kiosk deployments on clean
machines:

```bash
bun run package:kiosk -- apps/interactive-pool                      # this machine's target
bun run package:kiosk -- apps/interactive-pool --target linux-x64   # Linux x64 AppImage
bun run package:kiosk -- apps/interactive-pool --macos              # macOS arm64 DMG, on a Mac
```

Options: `--target <linux-x64|mac-arm64|win-x64>` (default: this machine),
`--macos` (same as `--target mac-arm64`), `--experience <slug>` (default: the
manifest's `default`), `--display <index>` (default: primary),
`--python-extras <list>` (extra Python dependencies such as
`speech`), `--windowed`, `--skip-build` (reuse the workspace and
app builds).

The bundle contains the same runtime as the regular desktop package
(Electron shell, compiled `gosai-server`, `uv`, Python tree) plus:

- `resources/apps/<slug>/`: only the packaged app, plus the built-in
  calibration app when the app declares a built-in calibration kind.
- `resources/kiosk.json`: tells the shell to boot into this app.

At launch the shell:

1. Uses an isolated data directory at `~/.gosai-kiosks/<slug>` (override
   with `GOSAI_HOME`) holding config, storage, logs, and the Electron
   profile, so kiosks never share state with each other or with a regular
   GOSAI install. Two kiosks with the same data directory can't run at once.
2. Prepares the Python runtime and starts the server on an ephemeral port as
   described above, so any number of kiosks can run side by side with no
   port configuration.
3. Runs the app's calibration when needed (see below).
4. Starts the app's experience and opens it fullscreen on the primary
   display (or the display index baked in at packaging time).

Closing the window quits the kiosk with exit code 0. When the server or a
window's renderer process dies, the kiosk exits with code 1. Artifacts land
in `packages/desktop/release/kiosk/<slug>/`.

### Running and configuring on the kiosk machine

```bash
chmod +x "Second Self-kiosk-1.0.0-linux-x86_64.AppImage"
"./Second Self-kiosk-1.0.0-linux-x86_64.AppImage"
```

Settings are read from command-line flags first, then environment variables,
then the values baked in at packaging time, so a deployed kiosk can be
re-pointed without rebuilding:

| Flag                          | Variable                    | Effect                                            |
| ----------------------------- | --------------------------- | ------------------------------------------------- |
| `--kiosk <app-dir>`           | `GOSAI_KIOSK_APP`           | Run this built app instead of the packaged one    |
| `--kiosk-home <dir>`          | `GOSAI_HOME`                | Data directory (default `~/.gosai-kiosks/<slug>`) |
| `--kiosk-display <index>`     | `GOSAI_KIOSK_DISPLAY`       | Display index (0-based)                           |
| `--kiosk-experience <slug>`   | `GOSAI_KIOSK_EXPERIENCE`    | Experience slug to boot                           |
| `--kiosk-windowed`            | `GOSAI_KIOSK_WINDOWED=1`    | Window instead of fullscreen                      |
| `--kiosk-python-extras <a,b>` | `GOSAI_KIOSK_PYTHON_EXTRAS` | Comma-separated Python extras                     |
| `--kiosk-calibrate`           | `GOSAI_KIOSK_CALIBRATE=1`   | Force the calibration on this launch              |

Device assignments (which camera / microphone / resolution the app uses)
live in `<home>/data/<slug>/device-settings.json` and persist across
launches. App key/value storage (calibration profiles, ...) is under
`<home>/data/<slug>/storage/`; logs under `<home>/logs/`. The server moves data
from the old `<home>/apps/<slug>/_data` and `_config` locations on its first
start, and uninstalling an app keeps its data.

### Calibration

Apps that declare a built-in `calibration` kind in their manifest (e.g.
`interactive-pool`) are packaged together with the built-in calibration app.
Apps with their own flow (`calibration.experience`) run it themselves. On the
kiosk:

- **First boot:** if the app has `calibration.required: true` and isn't
  calibrated yet, the kiosk opens the calibration flow (fullscreen projector
  window + control window) before starting the app. When the flow ends, the
  windows close and the app launches; if it was cancelled or failed, the app
  launches uncalibrated and the kiosk logs why.
- **Re-calibration** (camera or projector moved): relaunch with

  ```bash
  GOSAI_KIOSK_CALIBRATE=1 ./interactive-pool.AppImage
  ```

  The calibration runs first, then the app starts as usual. Later launches
  reuse the new profile.

The profile is one `calibration_profile` key in `<home>/data/<slug>/storage/`,
so wiping the data directory also clears calibration. Kiosks calibrated with an
older GOSAI keep their calibration: the server converts the old keys on first
read.

For unattended operation, a systemd user unit keeps the kiosk alive. With
`Restart=on-failure` it restarts after a crash but stays closed when someone
closes the window; use `Restart=always` to restart in both cases.

```ini
# ~/.config/systemd/user/gosai-kiosk.service
[Unit]
Description=GOSAI kiosk
After=graphical-session.target

[Service]
ExecStart=/opt/gosai/second-self.AppImage
Environment=GOSAI_KIOSK_DISPLAY=0
Restart=on-failure
RestartSec=3

[Install]
WantedBy=graphical-session.target
```

```bash
systemctl --user enable --now gosai-kiosk
```

### Running kiosks without a per-app bundle

Any GOSAI executable runs a built app as a kiosk with `--kiosk <app-dir>`
and the flags above:

```bash
./GOSAI-0.1.0-linux-x86_64.AppImage --kiosk /path/to/built-app --kiosk-display 1
/Applications/GOSAI.app/Contents/MacOS/GOSAI --kiosk /path/to/built-app
```

From the repository, build the desktop app and the SDK once, then:

```bash
bun run build:desktop && bun run build:sdk
bun run kiosk apps/interactive-pool --kiosk-display 1 --kiosk-windowed
```

Each launch gets its own data directory and port exactly like a packaged
kiosk. From the repository the server runs from source with bun and uses
`python/.venv` (`bun run python:sync`).

## Environment variables

These apply to the packaged desktop app and kiosks. See
[`quick-start.md`](quick-start.md#environment-variables) for the full list.

| Variable                   | Effect                                                                         |
| -------------------------- | ------------------------------------------------------------------------------ |
| `GOSAI_HOME`               | Server data directory (default `~/.gosai`, `~/.gosai-kiosks/<slug>` in kiosks) |
| `GOSAI_PYTHON=0`           | Skip the Python runtime and disable Python drivers                             |
| `GOSAI_PYTHON_DIR`         | Use this Python directory instead of installing the runtime                    |
| `GOSAI_AUTOSTART_SERVER=0` | Don't start a server; connect to one on `GOSAI_PORT` (default 7777)            |
| `GOSAI_SERVER_BIN`         | Start this server executable instead of the bundled one                        |
| `GOSAI_OZONE_PLATFORM`     | Linux: `wayland` or `auto` instead of the default XWayland backend             |

`GOSAI_PORT` and `GOSAI_HOST` don't change the embedded server, which always
listens on `127.0.0.1` with an ephemeral port.

## Troubleshooting

| Symptom                                              | Likely cause                                                                                                                                            |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "the bundled server is missing"                      | The package was built without `scripts/prepare-bundle.ts`. Rebuild with `bun run package:<platform>`.                                                   |
| "GOSAI started with problems": Python drivers        | The first-run `uv` install failed, usually without network. Relaunch once online. Logs are in `<GOSAI_HOME>/logs/` and on the terminal that started it. |
| Launching GOSAI again does nothing                   | Another instance with the same data directory is running; it gets focus instead.                                                                        |
| App install fails with "git: command not found"      | `git` is not in PATH for the GUI process.                                                                                                               |
| A kiosk restarts in a loop under systemd with exit 1 | Its server or renderer keeps dying, or its settings are invalid. The kiosk shows the error on screen for 15 seconds before exiting.                     |
