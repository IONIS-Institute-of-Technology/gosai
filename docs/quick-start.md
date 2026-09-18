# Quick start (developer)

Get GOSAI running locally and your first app installed in under five
minutes.

## 1. Bootstrap

```bash
git clone https://github.com/IONIS-Institute-of-Technology/gosai ~/Repos/gosai
cd ~/Repos/gosai
bun install
bun run python:sync                # builds python/.venv with uv
bun run build:sdk                  # builds the SDK bundle served to app windows
bun run build:apps                 # builds built-in app entry bundles
```

All Python driver dependencies (OpenCV, MediaPipe, ONNX Runtime, audio) are
installed automatically by `python:sync`, with the CPU build of ONNX Runtime
(CoreML on macOS). In auto mode, ONNX drivers use CUDA when the `gpu` extra is
installed and CoreML on macOS. The Drivers panel lists every driver, including
those no app uses, with the events, actions and config options its schema
declares, and the active hardware/provider of each running driver.

Camera mode selectors list modes that the Python runtime can actually open and
decode, including MJPG/H264 modes needed by many 720p/30 webcams. Selecting a
mode is exact: if the camera cannot deliver the chosen resolution/FPS, the
camera driver errors instead of silently dropping to a lower resolution.

For NVIDIA GPUs and optional drivers, add extras (see `python/README.md`):

```bash
cd python && uv sync --extra gpu --no-group cpu   # CUDA onnxruntime on NVIDIA GPUs
cd python && uv sync --extra speech      # Whisper speech recognition
```

## 2. Run dev mode

```bash
bun run dev
```

Three processes start with one shared dashboard token:

- The server on `http://127.0.0.1:7777` (`GOSAI_PORT` changes the port).
- The SDK bundle watcher.
- The Electron desktop app, connected to that server.

The dashboard appears with five tabs: Apps · Experiences · Drivers · Logs ·
Settings. Tabs keep their state when you switch between them, so log filters
and camera mode probes survive.

## 3. Install an app from git

```
Apps tab → "Install an app" → paste a git URL → Install
```

The server clones the repo into `~/.gosai/apps/<slug>/`, runs
`bun install --production` when the app has runtime dependencies (with
`--frozen-lockfile` when it commits `bun.lock`) and `bun run build`, and
refreshes the app list. The app now
appears under "Installed" with a "Start" button.

A prompt then shows the app's icon, author, the capabilities it requests with
what each allows, and any extra network origins from `network.connect`. The app
holds none of the requested capabilities until you allow them; closing the
prompt allows none. Expand the app's row and click "permissions" to change them
later. If an earlier app with the same slug left data from another source, the
dashboard asks before reusing it, and "uninstall" asks whether to delete the
app's data too.

## 4. Start an experience

Click "Start" on the app's row to run its default experience, or expand the
row to pick another one. The dashboard only asks the server to start it. The
Electron main process follows the server's experience state: when an experience
runs, main opens its window, and when it stops or crashes, main closes it. That
also covers experiences started or stopped elsewhere, such as an app calling
`rt.router.switchTo`. The Experiences tab lists running experiences and the
windows main has open. When an experience crashes, because its start failed
or its window stopped it after repeated render errors, the app's row says why
until the app starts again.

The window opens on the app's own display assignment (expand the row, "device
assignments"), else on the display chosen in the Settings tab, else on the
primary display, in fullscreen unless the app is set to windowed. It loads the
app host page from `http://<slug>.localhost:<port>/`, which runs the
experience. Picking "Default" for an app's camera, microphone or speaker
removes the app's override, so it follows the global setting again.

## 5. Build your own app

The fastest path is to copy [`templates/basic/`](../templates/basic) into a
new repo, change the manifest slug, push it to a git host, then install
from the URL. The template is a standalone project, so it builds anywhere, not
only inside this repository. Its dev dependencies, `@gosai/sdk` from npm and
TypeScript, are only for your editor and type checking: the build leaves the
SDK to GOSAI, and GOSAI's installer skips dev dependencies. See
[`packages/sdk/README.md`](../packages/sdk/README.md) for the SDK reference
and [`drivers.md`](drivers.md) for the drivers.

```bash
cp -R templates/basic ~/Code/my-gosai-app
cd ~/Code/my-gosai-app
bun install
# edit gosai.app.json (slug, name, description)
# edit src/main.ts to build your experience
bun run typecheck
bun run build
git init && git add . && git commit -m "initial"
# push to a host then paste the clone URL into the dashboard
```

The manifest's `sdk` range names the SDK versions the app works with. GOSAI
refuses to install an app whose range doesn't include the SDK it serves.

## Environment variables

| Variable                   | Effect                                                                                              |
| -------------------------- | --------------------------------------------------------------------------------------------------- |
| `GOSAI_HOME`               | Data directory: config, app storage, installed apps, logs (default `~/.gosai`).                     |
| `GOSAI_HOST`               | Server bind host (default `127.0.0.1`). The desktop app's own server always uses `127.0.0.1`.       |
| `GOSAI_PORT`               | Server bind port (default `7777`). The dev desktop connects to it; the desktop's own server uses 0. |
| `GOSAI_PYTHON_DIR`         | Override the Python source/venv directory. Skips the packaged first-run Python install.             |
| `GOSAI_BUILTIN_APPS`       | Override the built-in apps discovery root.                                                          |
| `GOSAI_PYTHON=0`           | Disable the Python bridge entirely.                                                                 |
| `GOSAI_PYTHON_SETUP_ERROR` | Set by the desktop app for its server: why the Python runtime could not be installed.               |
| `GOSAI_UV`                 | uv used to build the Python environments of apps with drivers (default: bundled, or `uv` on PATH).  |
| `GOSAI_UV_CACHE_DIR`       | uv cache for those environments (default: uv's own; `~/.gosai-runtime/uv-cache` when packaged).     |
| `GOSAI_SDK_DIR`            | Directory of the built SDK bundle the server serves under `/sdk/<version>/`.                        |
| `GOSAI_AUTOSTART_SERVER=1` | Make the desktop app start its own server when run from source.                                     |
| `GOSAI_AUTOSTART_SERVER=0` | Make the packaged desktop app connect to a server started separately.                               |
| `GOSAI_SERVER_BIN`         | Server executable the desktop app starts instead of the bundled one or the source.                  |
| `BUN_BIN`                  | bun executable used to run the server from source (default `~/.bun/bin/bun`, then `PATH`).          |
| `GOSAI_OZONE_PLATFORM`     | Linux only: `wayland` or `auto` instead of the default XWayland backend.                            |
| `GOSAI_DASHBOARD_TOKEN`    | Token shared by a server and desktop app started separately.                                        |
| `GOSAI_ALLOWED_ORIGINS`    | Extra allowed origins, comma-separated.                                                             |
| `GOSAI_ALLOWED_HOSTS`      | Extra allowed `Host` names, e.g. a LAN address.                                                     |
| `GOSAI_ACCELERATOR=auto`   | CUDA on NVIDIA and CoreML on macOS.                                                                 |
| `GOSAI_ACCELERATOR=cpu`    | Explicit CPU mode for inference drivers.                                                            |
| `GOSAI_CUDA_DEVICE_ID=0`   | Select the NVIDIA GPU for CUDA inference.                                                           |

Kiosk variables are listed in [`deployment.md`](deployment.md#running-and-configuring-on-the-kiosk-machine).

## Tests

```bash
bun run typecheck
bun run lint
bun run test
bun run python:check
```

`bun run test` includes a contract test that drives the real Python bridge
with the `heartbeat` driver; it is skipped when `python/.venv` is missing.

`packages/server/test/phase7-e2e.ts` boots a server, installs the template app
from a local git repo, runs and stops it, then uninstalls it. It only runs
when `GOSAI_E2E_INSTALL=1` is set (`bun run --filter @gosai/server test:install`).
