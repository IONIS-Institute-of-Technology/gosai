# Phase 2 Summary - Core Server

## Outcome

The GOSAI server is fully operational. It boots a Bun HTTP + WebSocket
service, spawns and supervises a Python bridge process that hosts drivers as
threads, manages app installation and experience lifecycle, and streams logs,
driver events, and system metrics to connected clients over the WebSocket.
The whole pipeline (server -> bridge -> Python driver -> event -> client)
has been validated end-to-end with a heartbeat driver.

## What Was Built

### Server-side TypeScript (`packages/server/src/`)

| Module | Purpose |
|--------|---------|
| `logger/` | `Logger` + `ChildLogger`: structured entries, configurable min level, in-memory backlog (500 entries), disk persistence with rotation at 5 MB, subscriber notifications. |
| `ipc/bus.ts` | `EventBus`: in-process pub/sub with exact, namespace wildcard (`prefix:*`), and global (`*`) listeners. Listener exceptions are swallowed so they can never propagate. |
| `ipc/gateway.ts` | `WebSocketGateway`: bridges the EventBus to clients. Welcome envelopes, typed RPC request/response routing via `id`, per-client subscription sets, broadcast based on subscription patterns. |
| `config/config.ts` | `ConfigStore`: global config persisted as JSON in `paths.config/global.json`. Emits `server:config-changed` on update. |
| `drivers/bridge.ts` | `PythonBridge`: spawns `python/.venv/bin/gosai-bridge` via `Bun.spawn`. Multiplexes JSON-line requests, handles ready/pong/result/event/log/driver-state/performance messages. Includes start/stop, timeouts, and request cancellation. |
| `drivers/manager.ts` | `DriverManager`: tracks driver state, propagates `driver:event` and `driver:state-changed` on the bus, resolves dependencies, manages subscription reference counts, exposes `startDriver`/`stopDriver`/`subscribe`/`unsubscribe`/`execute`/`getData`. |
| `apps/manifest.ts` | `gosai.app.json` parsing and validation. Enforces slug pattern, required fields, experience shape, optional python config. |
| `apps/installer.ts` | `installApp`, `uninstallApp`, `linkBuiltinApp`. Clones git repos via `git clone --depth 1` with 5 min timeout, runs `uv pip install -r requirements.txt` when declared, atomic rename into the apps directory. |
| `apps/manager.ts` | `AppManager`: catalogue of installed apps + running experiences, lifecycle (`startExperience`, `stopExperience`), exclusive mode enforcement, required experience auto-start, per-app `_data` and `_config` directories. |
| `monitor/monitor.ts` | `SystemMonitor`: CPU% / memory / uptime sampled every 2 s. Subscribes to `server:performance` from the bus and keeps the last 200 samples. |
| `server.ts` | Composes everything: instantiates `Logger`, `EventBus`, `ConfigStore`, `DriverManager`, `AppManager`, `SystemMonitor`, `WebSocketGateway`. Registers command handlers and REST routes. Graceful shutdown. |
| `index.ts` | Resolves `GOSAI_PORT`, `GOSAI_HOST`, `GOSAI_PYTHON_DIR`, `GOSAI_BUILTIN_APPS`, signals. |

### Python (`python/src/gosai_py/`)

| Module | Purpose |
|--------|---------|
| `driver.py` | `BaseDriver` + `DriverContext`. Drivers declare `name`, `description`, `events`, `actions`, `dependencies`, `loop_interval_s`. Lifecycle hooks: `pre_run`, `loop`, `on_event`, `execute`, `cleanup`. Built-in performance recording for each loop iteration. Stop event for clean shutdown. |
| `bridge.py` | Full bridge runtime. Discovers drivers via `pkgutil.iter_modules` over `gosai_py.drivers`, maintains class registry, per-driver instances, internal callback subs (Python -> Python) and external subscriber counts (Python -> Node). Handles `ping`, `list-drivers`, `start-driver`, `stop-driver`, `subscribe`, `unsubscribe`, `get-data`, `execute`, `shutdown`. |
| `drivers/heartbeat.py` | First built-in driver. Emits `tick` every 500 ms, supports an `echo` action. Used for end-to-end plumbing tests. |

### REST endpoints (HTTP)

| Path | Description |
|------|-------------|
| `GET /healthz` | Liveness probe |
| `GET /v1/info` | Protocol/server version + storage paths |
| `GET /v1/apps` | Installed apps |
| `GET /v1/drivers` | Driver manifest + state |
| `GET /v1/experiences` | Currently running experiences |
| `GET /v1/config` | Current global config |
| `GET /v1/logs` | In-memory log backlog |

### WebSocket commands (sent to `/ws`)

`subscribe`, `unsubscribe`, `apps:list`, `app:install`, `app:uninstall`,
`experiences:list`, `experience:start`, `experience:stop`, `drivers:list`,
`driver:get-data`, `driver:execute`, `driver:subscribe`,
`driver:unsubscribe`, `logs:history`, `config:get`, `config:set`.

### WebSocket events (broadcast from server)

`server:welcome`, `server:log`, `server:performance`,
`server:config-changed`, `driver:event`, `driver:state-changed`,
`drivers:list-changed`, `app:installed`, `app:uninstalled`,
`apps:list-changed`, `experience:state-changed`,
`experiences:list-changed`, `system:stats`.

## Verified Working

- `bun run typecheck` clean across all packages.
- `bun test` in `packages/server`: 13 tests across bus, logger, manifest -
  all pass.
- `uv run pytest -q`: bridge import + version smoke - all pass.
- `uv run ruff check src`: clean.
- `bun packages/server/test/smoke-e2e.ts`: full pipeline test that boots
  the server, spawns the bridge, lists `heartbeat` in driver manifest,
  subscribes via WebSocket, receives `driver:event` payloads, executes
  `heartbeat.echo`, gets the response, unsubscribes, shuts down. PASSES.
- `bun run --filter @gosai/server build` produces a single bundle.

## Files Created or Modified This Phase

```
packages/server/src/
├── server.ts                     # rewritten (composition root)
├── index.ts                      # env/cli wiring
├── paths.ts                      # unchanged
├── logger/{logger.ts,index.ts}
├── ipc/{bus.ts,gateway.ts,index.ts}
├── config/{config.ts,index.ts}
├── drivers/{bridge.ts,manager.ts,index.ts}
├── apps/{manifest.ts,installer.ts,manager.ts,index.ts}
└── monitor/{monitor.ts,index.ts}

packages/server/test/
├── bus.test.ts
├── logger.test.ts
├── manifest.test.ts
└── smoke-e2e.ts                  # full stack integration

packages/shared/src/
├── types.ts                      # DriverState now includes 'stopping'

python/src/gosai_py/
├── bridge.py                     # full driver hosting runtime
├── driver.py                     # BaseDriver + DriverContext
└── drivers/heartbeat.py          # first built-in driver
```

## Conventions Locked In for Later Phases

1. **All cross-process traffic uses JSON.** Binary frames are not yet
   supported; Phase 5/6 drivers that need image frames should base64-encode
   or split bulk data into a side channel (not added yet).
2. **Driver registration**: name = stable identifier, declared via class
   attribute. Bridge discovers every BaseDriver subclass under
   `gosai_py.drivers`.
3. **Subscriber semantics**: when an experience starts, the AppManager
   subscribes (driver, `*`) on its behalf, which auto-starts the driver. On
   stop, it unsubscribes; the DriverManager stops the driver when no
   subscribers remain.
4. **Errors**: every public method on managers throws on invariant
   violations (unknown driver, missing app). Handlers in the gateway
   convert thrown errors into `{ ok: false, error: { code, message } }`
   responses.
5. **Naming**: events use `namespace:event-name`, RPC commands use
   `namespace:action`. Stick with this for new commands.
6. **Storage**: per-app data lives at
   `paths.apps/<slug>/{_data,_config}/`. Apps using the SDK (Phase 4) will
   get convenient wrappers around these paths.

## Known Limitations (intentional, deferred)

- No binary frame channel for high-bandwidth driver data (Phase 5/6 will
  introduce one, likely via MessagePack on a separate WebSocket).
- The bridge does not yet hot-reload drivers when source files change.
- App installer assumes `uv` is available on PATH if the manifest declares
  Python requirements.
- No per-app log file (all logs share `gosai.log`); per-app logs land in
  Phase 4 with the SDK.

## Open Items for Phase 3

The desktop is currently a single-page status view. Phase 3 must:

- Build out the dashboard surface (apps grid, drivers panel, system monitor,
  running experiences panel, logs viewer, settings).
- Wire the dashboard renderer to the server via WebSocket (use protocol
  types in `@gosai/shared/protocol`).
- Spawn the fullscreen app-host window on the configured display.
- Integrate `node-pty` + `xterm.js` for the embedded terminal.
- Add a server-launch policy in the main process (spawn the server as a
  child or rely on the dev script - decide based on packaging strategy).
