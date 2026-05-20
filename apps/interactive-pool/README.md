# Interactive Pool

Augmented-reality pool table experience for GOSAI v2. A camera tracks the
balls, hands, and cue on the table; a projector overlays interactive visuals
in real-time. A single composited experience drives the entire app:

- Always-on overlays: ball circles, cue line, hand skeletons.
- Gesture-driven menu (pinch with two index fingers, spread to open).
- Five launchable layers: rabbits game, affine function plotter, triangle
  geometry, "univers" (galaxy + per-ball solar systems), and ambient display.
- Optional live ball-data relay to an external server.

## Drivers used

| Driver         | Why                                         |
| -------------- | ------------------------------------------- |
| `ball`         | Detected ball positions and FPS             |
| `cue`          | Cue stick line endpoints                    |
| `hand_pose`    | MediaPipe-style 21-point hand landmarks     |
| `sensor_server`| Optional, only used by ambient display      |

Drivers declared in `gosai.app.json` are auto-started by the server when the
experience starts. `sensor_server` is intentionally not declared so that the
app runs without it; the ambient layer subscribes lazily and degrades to a
passive starfield if the driver isn't available.

## Build

```bash
bun install
bun run build         # one-shot bundle into dist/
bun run dev           # watch mode
bun run typecheck     # tsc --noEmit
```

## Live streaming

The optional `live` layer mirrors ball positions to an external WebSocket
endpoint. The URL is read from the app's key/value storage under
`live_server_url`; if empty the layer is dormant. Set it via the dashboard
(or any other gosai-2 storage tool):

```
POST /v1/apps/interactive-pool/storage/live_server_url
"wss://example.com/realtimepool/ws"
```

## Audio

Drop optional `.mp3` files into `assets/audio/` to enable menu feedback. See
`assets/audio/README.md` for the expected filenames.
