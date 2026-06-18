# GOSAI

General-purpose Operating System for Augmented Interfaces.

GOSAI is a fullstack platform for building and running augmented-reality
experiences. The server orchestrates apps and drivers, a Python runtime hosts
ML/CV work, and the Electron desktop app provides the dashboard plus a
fullscreen window per running experience.

## Architecture

```
                    ┌──────────────────────────┐
                    │  Electron Desktop (UI)   │
                    │  • dashboard (config)    │
                    │  • app-host windows      │
                    └──────────┬───────────────┘
                               │ WebSocket
                    ┌──────────▼───────────────┐
                    │   Bun/TypeScript Server  │
                    │  • app lifecycle         │
                    │  • driver manager        │
                    │  • storage / config      │
                    └─┬──────────────────┬─────┘
              stdio │                  │ HTTP / WS
                    │                  │
       ┌────────────▼──────┐   ┌──────▼──────────────┐
       │ Python Bridge     │   │  Installed apps     │
       │  • camera, pose,  │   │  • experiences      │
       │    hand, audio... │   │  • optional Python  │
       └───────────────────┘   └─────────────────────┘
```

- **Apps** are git repositories with a `gosai.app.json` manifest. Each app
  contains one or more **experiences** that the user launches into a
  fullscreen window. Apps can ship Python drivers that run inside the
  bridge process.
- **Drivers** are stateful Python actors that publish events (camera
  frames, hand landmarks, audio chunks, ...) and accept actions. Apps
  subscribe to drivers via the SDK.
- The server is the single source of truth for state. Crashes in a
  driver or experience do not bring it down.

## Repository Layout

```
gosai-2/
├── packages/
│   ├── shared/      shared TS types + protocol
│   ├── server/      Bun/TypeScript server
│   ├── sdk/         TypeScript SDK for app authors
│   └── desktop/     Electron + React frontend
├── python/          Python runtime (uv-managed)
│   └── src/gosai_py/
│        ├── bridge.py    Node↔Python JSON-lines bridge
│        ├── driver.py    BaseDriver
│        ├── processor.py BaseProcessor
│        └── drivers/     Built-in drivers (camera, pose, hand_pose, ...)
├── apps/calibration/   Built-in calibration app
├── templates/basic/    Starter template
└── memory/             Phase notes (development history)
```

## Requirements

| Tool       | Min version | Notes                                |
| ---------- | ----------- | ------------------------------------ |
| **Bun**    | 1.2         | TypeScript runtime + bundler         |
| **uv**     | 0.5         | Python package + virtual env manager |
| **Node**   | 20.19       | Electron requires it                 |
| **Python** | 3.11        | The drivers target 3.11+             |
| **git**    | -           | For cloning external apps            |

## Quick Start

```bash
bun install
bun run python:sync          # creates python/.venv with uv
bun run python:sync -- --extra cv     # for camera/pose/hand_pose drivers
bun run python:sync -- --extra audio  # for microphone/speaker drivers
bun run python:sync -- --extra speech # for STT/VAD drivers
bun run build:sdk           # builds /sdk-runtime.js for app-host windows
bun run build:apps          # builds built-in app entry bundles
bun run dev
```

Two processes start:

1. The GOSAI server on `http://127.0.0.1:7777`.
2. The Electron desktop app, which connects to the server over WebSocket.

To install a new app paste its git URL into the Apps tab of the dashboard.

## Scripts

| Command                    | Purpose                                           |
| -------------------------- | ------------------------------------------------- |
| `bun run dev`              | Server + desktop with hot reload                  |
| `bun run dev:server`       | Only the server                                   |
| `bun run dev:desktop`      | Only the Electron app                             |
| `bun run build:sdk`        | Build the SDK runtime served at `/sdk-runtime.js` |
| `bun run build`            | Build every package                               |
| `bun run build:apps`       | Build the built-in apps + template                |
| `bun run build:server-bin` | Compile the server to a single executable         |
| `bun run typecheck`        | TypeScript check across the workspace             |
| `bun run python:sync`      | `uv sync` for the Python runtime                  |
| `bun run python:lint`      | `ruff check src` for the Python runtime           |
| `bun run python:test`      | `pytest` for the Python runtime                   |
| `bun run package:mac`      | Build server bin + macOS DMG (arm64+x64)          |
| `bun run package:linux`    | Build server bin + Linux AppImage                 |
| `bun run clean`            | Remove all build artifacts                        |

## Authoring an app

See [`packages/sdk/README.md`](packages/sdk/README.md) for the SDK reference
and [`templates/basic/README.md`](templates/basic/README.md) for a worked
example.

A minimal app looks like this:

```ts
import { defineExperience, fitCanvasToWindow } from '@gosai/sdk';

export default defineExperience<{ canvas: HTMLCanvasElement }>({
  slug: 'main',
  name: 'My Experience',
  init() {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    return { canvas };
  },
  render(_rt, state, frame) {
    fitCanvasToWindow(state.canvas);
    const ctx = state.canvas.getContext('2d')!;
    ctx.fillStyle = `hsl(${frame.elapsed / 10} 80% 50%)`;
    ctx.fillRect(0, 0, state.canvas.width, state.canvas.height);
  },
});
```

A matching `gosai.app.json`:

```json
{
  "slug": "my-app",
  "name": "My App",
  "version": "0.1.0",
  "requirements": { "display": true, "camera": true },
  "experiences": [{ "slug": "main", "name": "Main", "entry": "dist/main.js" }]
}
```

## Running apps in parallel & per-app devices

Multiple apps can run at the same time. To keep them from fighting over the same
hardware, GOSAI binds drivers **per app** (the _binding_ is the app slug):

- **Exclusive drivers** (the default) — `camera`, `microphone`, and anything that
  depends on them (`hand_pose`, `pose`, `ball`, ...) — get their own instance per
  app, so two apps can read two different cameras simultaneously.
- **Shared drivers** — `speaker` and device-less utilities like `heartbeat` — are
  shared across apps (apps pointed at the same speaker mix into one stream).

An app declares which device _slots_ it needs with a top-level `requirements`
object in its manifest:

```jsonc
"requirements": {
  "display": true,      // opens a window (fullscreen or windowed)
  "camera": true,       // binds an exclusive camera
  "microphone": false,
  "speaker": false
}
```

Each declared slot shows up in the dashboard's per-app **device assignments**
panel, where you pick the concrete camera / microphone / speaker and the target
display (with a fullscreen ⇄ windowed toggle). Assignments persist to
`~/.gosai/apps/<slug>/_config/settings.json` and are applied when the app starts
(camera/microphone changes also hot-apply to a running instance).

Calibration is also per app, but it is declared separately with a top-level
`calibration` object. Apps that need it provide a browser ESM calibration entry;
GOSAI's built-in calibration runner loads that entry and writes the resulting
profile into the target app's own storage.

## Packaging

```bash
bun run package:mac     # produces packages/desktop/release/GOSAI-*.dmg
bun run package:linux   # produces packages/desktop/release/GOSAI-*.AppImage
```

The packaged app bundles:

- The compiled GOSAI server as a single binary.
- The Python source tree (the `.venv` is materialised on first run).
- The built-in `calibration` app + the SDK runtime bundle.

See [`docs/deployment.md`](docs/deployment.md) for the full packaging guide.

## License

GPL-3.0
