# Interactive Pool

Augmented-reality pool table experience for GOSAI. A camera tracks the
balls and hands on the table; a projector overlays interactive visuals
in real-time. A single composited experience drives the entire app:

- Always-on overlays: ball circles and hand skeletons.
- Gesture-driven menu (pinch with two index fingers, spread to open).
- Five launchable layers: rabbits game, affine function plotter, triangle
  geometry, "univers" (galaxy + per-ball solar systems), and ambient display.
- Optional live ball-data relay to an external server.

## Drivers used

| Driver      | Why                                     |
| ----------- | --------------------------------------- |
| `ball`      | Detected ball positions and FPS         |
| `hand_pose` | MediaPipe-style 21-point hand landmarks |

Drivers declared in `gosai.app.json` are auto-started by the server when the
experience starts.

The `ball` driver runs a fine-tuned single-class billiard-ball model
(`python/src/gosai_py/drivers/ball_models/ball.onnx`). It is produced by the
training pipeline in [`training/`](../../training/README.md); run that pipeline
to (re)generate the model if ball detection needs improving.

## Settings

Edit these in the dashboard's app settings. A running experience picks up
changes right away.

| Setting           | Default | What it does                                                |
| ----------------- | ------- | ----------------------------------------------------------- |
| `debug.title`     | on      | Projects "INTERACTIVE POOL PROJECT" along the bottom edge.  |
| `debug.renderFps` | off     | Projects the render frame rate in the top-left corner.      |
| `debug.ballFps`   | off     | Projects the ball detection rate along the bottom edge.     |
| `live.url`        | empty   | WebSocket URL of the live relay. Empty turns the relay off. |

## Build and test

```bash
bun install
bun run build         # one-shot bundle into dist/
bun run dev           # watch mode
bun run typecheck     # tsc for src/ and test/
bun run test          # unit tests
```

## Live streaming

The `live` layer mirrors ball positions to an external WebSocket server. Each
time the ball driver reports, it sends
`{ "ts": <ms since epoch>, "balls": [{ "x": 0..1, "y": 0..1 }, ...] }`, with
positions normalised over the table. Set the server URL in the `live.url`
setting; the layer reconnects with back-off when the connection drops.

Older versions read the URL from the `live_server_url` storage key. The app
moves such a value into `live.url` the first time it starts.

### Relays on `ws://`

The app window may open `wss://` connections to any host. A plain `ws://`
relay, for example one on the local network, is blocked by the app's Content
Security Policy unless `gosai.app.json` lists its origin (scheme, host and
port, without a path):

```json
"network": { "connect": ["ws://192.168.1.50:8080"] }
```

The manifest is fixed when the app is installed, so the setting can't add an
origin by itself. When `live.url` names a `ws://` origin the manifest doesn't
list, the app logs which entry to add and leaves the relay off. To allow your
relay:

- **From a checkout or a kiosk build**: add the entry to
  `apps/interactive-pool/gosai.app.json`, then restart GOSAI or rebuild the
  kiosk package.
- **On an installed GOSAI**: add the entry in a fork of the app and install
  the fork from the dashboard. An installed app with the `interactive-pool`
  slug replaces the built-in one, and uninstalling it brings the built-in one
  back.

Prefer a `wss://` relay when you can: it needs no manifest change.

## Audio

Menu feedback sounds ship in `assets/audio/`: `opening_menu.mp3`,
`closing_menu.mp3` and `click.mp3`. They play through the runtime's
AudioContext. If a file is missing or fails to load, the app logs a warning and
that sound stays silent.
