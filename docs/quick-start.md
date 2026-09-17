# Quick start (developer)

Get GOSAI running locally and your first app installed in under five
minutes.

## 1. Bootstrap

```bash
git clone https://github.com/gosai/gosai ~/Repos/gosai
cd ~/Repos/gosai
bun install
bun run python:sync                # builds python/.venv with uv
bun run build:sdk                  # builds /sdk-runtime.js for app-host windows
bun run build:apps                 # builds built-in app entry bundles
```

All Python driver dependencies (OpenCV, MediaPipe, ONNX Runtime, audio) are
installed automatically by `python:sync`, with the CPU build of ONNX Runtime
(CoreML on macOS). In auto mode, ONNX drivers use CUDA when the `gpu` extra is
installed and CoreML on macOS. The Drivers panel shows the active
hardware/provider for each running driver.

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

Two processes start:

- `cyan` server on `http://127.0.0.1:7777`.
- `magenta` Electron desktop app connected to it.

The dashboard appears with five tabs: Apps · Drivers · Experiences ·
Terminal · Logs · Settings.

## 3. Install an app from git

```
Apps tab → "Install from URL" → paste a git URL → Install
```

The server clones the repo into `~/.gosai/apps/<slug>/`, runs any necessary
`bun install` / `bun run build`, and refreshes the app list. The app now
appears in the dashboard with a "Start" button next to each experience.

## 4. Start an experience

Click "Start" next to an experience. The Electron main process opens a
fullscreen window on the configured display (Settings tab). The window
loads `/v1/apps/<slug>/static/<entry>` from the server and runs the
experience.

To switch displays, open Settings, pick a different monitor, and the next
experience start will use it.

## 5. Build your own app

The fastest path is to copy [`templates/basic/`](../templates/basic) into a
new repo, change the manifest slug, push it to a git host, then install
from the URL. See [`packages/sdk/README.md`](../packages/sdk/README.md) for
the SDK reference.

```bash
cp -R templates/basic ~/Code/my-gosai-app
cd ~/Code/my-gosai-app
# edit gosai.app.json (slug, name, description)
# edit src/main.ts to build your experience
bun run build
git init && git add . && git commit -m "initial"
# push to a host then paste the clone URL into the dashboard
```

## Environment variables

| Variable                   | Effect                                                       |
| -------------------------- | ------------------------------------------------------------ |
| `GOSAI_HOST`               | Server bind host (default `127.0.0.1`).                      |
| `GOSAI_PORT`               | Server bind port (default `7777`).                           |
| `GOSAI_PYTHON_DIR`         | Override the Python source/venv directory.                   |
| `GOSAI_BUILTIN_APPS`       | Override the built-in apps discovery root.                   |
| `GOSAI_PYTHON=0`           | Disable the Python bridge entirely.                          |
| `GOSAI_AUTOSTART_SERVER=1` | Force the desktop app to spawn the server itself.            |
| `GOSAI_DASHBOARD_TOKEN`    | Token shared by a server and desktop app started separately. |
| `GOSAI_ALLOWED_ORIGINS`    | Extra allowed origins, comma-separated.                      |
| `GOSAI_ALLOWED_HOSTS`      | Extra allowed `Host` names, e.g. a LAN address.              |
| `GOSAI_ACCELERATOR=auto`   | CUDA on NVIDIA and CoreML on macOS.                          |
| `GOSAI_ACCELERATOR=cpu`    | Explicit CPU mode for inference drivers.                     |
| `GOSAI_CUDA_DEVICE_ID=0`   | Select the NVIDIA GPU for CUDA inference.                    |

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
