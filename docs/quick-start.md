# Quick start (developer)

Get GOSAI running locally and your first app installed in under five
minutes.

## 1. Bootstrap

```bash
git clone https://github.com/gosai/gosai-2 ~/Repos/gosai-2
cd ~/Repos/gosai-2
bun install
bun run python:sync                # builds python/.venv with uv
bun run build:sdk                  # builds /sdk-runtime.js for app-host windows
bun run build:apps                 # builds built-in app entry bundles
```

All Python driver dependencies (OpenCV, MediaPipe, ONNX Runtime, audio) are
installed automatically by `python:sync`. For optional hardware-specific
drivers, add extras:

```bash
cd python && uv sync --extra realsense   # Intel RealSense depth camera
cd python && uv sync --extra speech      # Whisper speech recognition (requires torch)
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

| Variable                  | Effect                                            |
| ------------------------- | ------------------------------------------------- |
| `GOSAI_HOST`              | Server bind host (default `127.0.0.1`).           |
| `GOSAI_PORT`              | Server bind port (default `7777`).                |
| `GOSAI_PYTHON_DIR`        | Override the Python source/venv directory.        |
| `GOSAI_BUILTIN_APPS`      | Override the built-in apps discovery root.        |
| `GOSAI_PYTHON=0`          | Disable the Python bridge entirely.               |
| `GOSAI_AUTOSTART_SERVER=1`| Force the desktop app to spawn the server itself. |

## Tests

```bash
bun run typecheck
bun run python:test
bun run python:lint
```

End-to-end checks live in `packages/server/test/phase*-e2e.ts`. Each one
boots a fresh server, exercises a vertical slice, and tears down. They
require the workspace's `python/.venv` to be present.
