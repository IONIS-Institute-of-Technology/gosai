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
  fullscreen window. Apps can ship Python drivers, which run in a bridge
  process and Python environment of their own.
- **Drivers** are stateful Python actors that publish events (camera
  frames, hand landmarks, audio chunks, ...) and accept actions. Apps
  subscribe to drivers via the SDK.
- The server is the single source of truth for state. Crashes in a
  driver or experience do not bring it down.

## Repository Layout

```
gosai/
├── packages/
│   ├── shared/      shared TS types + protocol
│   ├── server/      Bun/TypeScript server
│   ├── sdk/         TypeScript SDK for app authors
│   └── desktop/     Electron + React frontend
├── python/          Python runtime (uv-managed)
│   └── src/gosai_py/
│        ├── bridge.py    Node↔Python JSON-lines bridge
│        ├── driver.py    BaseDriver
│        └── drivers/     Built-in drivers (camera, pose, hand_pose, ...)
├── apps/               Built-in apps (calibration, interactive-pool, second-self)
├── templates/basic/    Starter template, a standalone project outside the workspaces
└── training/           Model training pipeline (per-model under training/models/)
```

The `ball` driver used by `interactive-pool` runs a fine-tuned single-class
billiard-ball model (`drivers/ball_models/ball.onnx`). Produce or update it (and
train future driver models) with the multi-model pipeline in
[`training/`](training/README.md).

## Requirements

| Tool       | Min version | Notes                                |
| ---------- | ----------- | ------------------------------------ |
| **Bun**    | 1.4.2       | TypeScript runtime + bundler         |
| **uv**     | 0.5         | Python package + virtual env manager |
| **Node**   | 22.12       | Electron requires it                 |
| **Python** | 3.12        | The drivers target 3.12+             |
| **git**    | -           | For cloning external apps            |

## Quick Start

```bash
bun install
bun run python:sync          # creates python/.venv with uv (CV + audio included)
bun run python:sync -- --extra gpu --no-group cpu # CUDA onnxruntime on NVIDIA GPUs
bun run python:sync -- --extra speech    # for the speech-to-text driver
bun run build:sdk           # builds the SDK bundle served to app windows
bun run build:apps          # builds built-in app entry bundles
bun run dev
```

Two processes start:

1. The GOSAI server on `http://127.0.0.1:7777`.
2. The Electron desktop app, which connects to the server over WebSocket.

To install a new app paste its git URL into the Apps tab of the dashboard.

## Scripts

| Command                       | Purpose                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------- |
| `bun run dev`                 | Server, SDK runtime and desktop with hot reload                                 |
| `bun run dev:server`          | Only the server                                                                 |
| `bun run dev:desktop`         | Only the Electron app                                                           |
| `bun run build:sdk`           | Build the SDK bundle served to app windows at `/sdk/<version>/`                 |
| `bun run build`               | Build every package                                                             |
| `bun run build:apps`          | Build the built-in apps                                                         |
| `bun run drivers:types`       | Regenerate the SDK's driver types and `docs/drivers.md` from the Python schemas |
| `bun run drivers:types:check` | Fail when those files drift from the Python schemas                             |
| `bun run sdk:check-package`   | Pack `@gosai/sdk` and build the template against the tarball in isolation       |
| `bun run bundle:prepare`      | Compile the server and fetch uv for packaging                                   |
| `bun run typecheck`           | TypeScript check across the workspace                                           |
| `bun run lint`                | oxlint across the workspace                                                     |
| `bun run test`                | Server, SDK and desktop tests                                                   |
| `bun run format:check`        | Prettier check across the workspace                                             |
| `bun run python:sync`         | `uv sync` for the Python runtime                                                |
| `bun run python:lint`         | `ruff check` for the Python runtime                                             |
| `bun run python:test`         | `pytest` for the Python runtime                                                 |
| `bun run python:check`        | ruff check, ruff format check, pyright and pytest for the Python runtime        |
| `bun run training:lint`       | `ruff check` and `ruff format --check` for the training pipeline                |
| `bun run package:linux`       | Linux x64 AppImage                                                              |
| `bun run package:mac`         | macOS arm64 DMG (on a Mac)                                                      |
| `bun run package:win`         | Windows x64 installer (best effort)                                             |
| `bun run package:kiosk`       | Build a single-app kiosk bundle (see below)                                     |
| `bun run kiosk`               | Launch a built app as a kiosk from the repo                                     |
| `bun run clean`               | Remove all build artifacts                                                      |

## Authoring an app

See [`packages/sdk/README.md`](packages/sdk/README.md) for the SDK reference
and [`templates/basic/README.md`](templates/basic/README.md) for a worked
example.

A minimal app looks like this:

```ts
import { createFullscreenCanvas, defineExperience, type FullscreenCanvas } from '@gosai/sdk';

export default defineExperience<{ view: FullscreenCanvas; hue: number }>({
  init(rt) {
    return { view: createFullscreenCanvas({ signal: rt.signal }), hue: 0 };
  },
  start(rt) {
    rt.log.info(`${rt.app.experience.name} started`);
  },
  render(_rt, state, frame) {
    state.view.fit();
    state.hue = (state.hue + frame.deltaMs / 20) % 360;
    state.view.ctx.fillStyle = `hsl(${state.hue} 80% 50%)`;
    state.view.ctx.fillRect(0, 0, state.view.canvas.width, state.view.canvas.height);
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
`~/.gosai/data/<slug>/device-settings.json` and are applied when the app starts
(camera/microphone changes also hot-apply to a running instance). The speaker
assignment only applies to the Python `speaker` driver: browser audio, such as
`rt.audio`, plays on the system output.

Calibration is also per app, declared with a top-level `calibration` object: a
`kind` such as the built-in `camera-projector-surface`, its `options`, and
whether the app is `required` to be calibrated before it starts. GOSAI's
built-in calibration app runs built-in kinds and saves one profile for the app;
an app can run its own flow instead by naming one of its experiences in
`calibration.experience`. See the SDK README.

## Kiosk mode

A kiosk runs exactly one app: no dashboard, one fullscreen window, its own
data directory (`~/.gosai-kiosks/<slug>` by default), and an embedded server
on an ephemeral port - several kiosks coexist on one machine with zero port
management.

Any GOSAI executable runs a built app as a kiosk with
`GOSAI --kiosk <app-dir>`. From the repo:

```bash
bun run build:desktop && bun run build:sdk   # once
bun run kiosk apps/interactive-pool          # add --kiosk-display 1, --kiosk-windowed, ...
```

Or package a self-contained kiosk bundle for a clean machine (embeds
Electron, the compiled server, the Python tree, `uv`, and only that app):

```bash
bun run package:kiosk -- apps/interactive-pool                     # this machine's target
bun run package:kiosk -- apps/interactive-pool --target linux-x64  # Linux x64 AppImage
```

On its first launch the bundle installs Python 3.12 and all CV driver
dependencies by itself (needs internet once); after that it runs offline.
Artifacts land in `packages/desktop/release/kiosk/<slug>/`. See
[`docs/deployment.md`](docs/deployment.md) for details.

## Packaging

```bash
bun run package:linux   # produces packages/desktop/release/GOSAI-*.AppImage
bun run package:mac     # produces packages/desktop/release/GOSAI-*.dmg (on a Mac)
```

The packaged app bundles:

- The compiled GOSAI server as a single binary.
- `uv` and the Python source tree (the `.venv` is materialised on first run).
- The built-in apps + the SDK runtime bundle.

See [`docs/deployment.md`](docs/deployment.md) for the full packaging guide.

## Credits

GOSAI began as a fork of [GOSAI-DVIC/gosai](https://github.com/GOSAI-DVIC/gosai).
The codebase has since been rewritten from scratch and shares no history or code
with the original — thanks to the original project for the starting point.

## License

GPL-3.0
