# Phase 1 Summary - Foundation and Infrastructure

## Outcome

A fully scaffolded Bun monorepo with TypeScript strict mode, an electron-vite
desktop shell, a Bun HTTP+WebSocket server, and a uv-managed Python runtime.
All packages typecheck and build. The server boots, exposes `/healthz` and
`/v1/info`, and accepts WebSocket connections. The Python bridge speaks the
stdio JSON-lines protocol (ping/pong only for now).

## Workspace Layout

```
gosai-2/
├── package.json                    # Bun workspace root
├── bunfig.toml                     # Bun install settings
├── tsconfig.base.json              # Shared TS config (strict)
├── tsconfig.json                   # Workspace references
├── .gitignore .prettierrc.json .prettierignore
├── README.md
├── packages/
│   ├── shared/                     # @gosai/shared
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/{index,types,events,protocol}.ts
│   ├── server/                     # @gosai/server (Bun runtime)
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/{index,server,paths}.ts
│   ├── sdk/                        # @gosai/sdk
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/index.ts
│   └── desktop/                    # @gosai/desktop (electron-vite)
│       ├── package.json
│       ├── electron.vite.config.ts
│       ├── tsconfig.json + tsconfig.node.json + tsconfig.web.json
│       └── src/
│           ├── main/index.ts       # Electron main process
│           ├── preload/dashboard.ts + app-host.ts
│           └── renderer/
│               ├── dashboard.html + app-host.html
│               └── src/
│                   ├── styles.css       # Tailwind v4 + theme tokens
│                   ├── types.d.ts       # Window augmentation
│                   ├── dashboard/{main,Dashboard}.tsx
│                   └── app-host/{main,AppHost}.tsx
├── python/                         # uv-managed Python runtime
│   ├── pyproject.toml              # gosai-py, optional extras for cv/audio/ml/speech
│   ├── .python-version             # 3.12 pinned
│   ├── uv.lock
│   ├── src/gosai_py/
│   │   ├── __init__.py
│   │   ├── version.py
│   │   ├── bridge.py               # stdio JSON-lines bridge (ping/pong stub)
│   │   ├── driver.py               # BaseDriver placeholder
│   │   └── drivers/__init__.py
│   └── tests/test_bridge_smoke.py
├── apps/                           # built-in apps (filled in Phase 5)
├── templates/                      # app starter templates (Phase 4)
└── memory/                         # phase summaries
```

## Key Technical Decisions Locked In

| Concern | Choice | Notes |
|---------|--------|-------|
| Monorepo | Bun workspaces with `workspace:*` protocol | Glob includes `packages/*`, `apps/*`, `templates/*` |
| TypeScript | strict mode + project references + composite | `tsconfig.base.json` is the single source of truth |
| Server runtime | Bun's native `Bun.serve` + Hono routes | Native WebSocket support |
| Frontend build | electron-vite v2.3 with React 19 + Tailwind v4 | Two HTML entries (`dashboard`, `app-host`) |
| Python | uv 0.11, Python 3.12 (pinned via `.python-version`) | Extras: `cv`, `audio`, `ml`, `speech`, `realsense`, `dev` |
| IPC bus | WebSocket (server↔desktop) + stdio JSON-lines (server↔python) | Wire formats defined in `@gosai/shared/protocol` |
| Logging | Structured `LogEntry` type ready | Implementation lands in Phase 2 |
| Bridge protocol | newline-delimited JSON | `BridgeRequest`/`BridgeResponse` types in shared |
| Storage layout | `~/.gosai/{apps,logs,data,config}` (override via `GOSAI_HOME`) | Created lazily on server boot |
| Server port | `7777` by default (override via `GOSAI_PORT`) | Bound to `127.0.0.1` only - no external access |

## Protocol Surfaces (already defined)

**WebSocket envelope** (`@gosai/shared/protocol.ts`):

```ts
interface MessageEnvelope<TType, TPayload> {
  v: 1;                // PROTOCOL_VERSION
  id?: string;
  type: TType;
  payload: TPayload;
  ts?: number;
}
```

**Server -> client** message variants are typed exhaustively
(`ServerMessage`): `server:welcome`, `server:log`, `server:performance`,
`server:config-changed`, `driver:event`, `driver:state-changed`,
`drivers:list-changed`, `app:installed`, `app:uninstalled`,
`apps:list-changed`, `experience:state-changed`,
`experiences:list-changed`, `system:stats`, `response`.

**Client -> server** message variants (`ClientMessage`): `subscribe`,
`unsubscribe`, `app:install`, `app:uninstall`, `apps:list`,
`experience:start`, `experience:stop`, `experiences:list`, `drivers:list`,
`driver:get-data`, `driver:execute`, `driver:subscribe`,
`driver:unsubscribe`, `logs:history`, `config:get`, `config:set`.

**Bridge protocol** (`BridgeRequest`/`BridgeResponse`): `ping`,
`list-drivers`, `start-driver`, `stop-driver`, `subscribe`, `unsubscribe`,
`get-data`, `execute`, `shutdown` (request side) and `pong`, `result`,
`event`, `log`, `driver-state`, `performance`, `ready` (response side).

## Verified Working

- `bun install` cleanly resolves all 4 workspace packages.
- `bun run typecheck` passes across `shared`, `server`, `sdk`, `desktop`.
- `bun run --filter @gosai/server build` produces a single bundle.
- `bun run --filter @gosai/desktop build` produces working main / preload /
  renderer outputs (`out/main`, `out/preload`, `out/renderer`).
- Direct server boot (`GOSAI_PORT=7778 bun src/index.ts`) responds to
  `/healthz` and `/v1/info`.
- `uv sync` installs the runtime and `uv run pytest -q` passes the smoke
  tests in `python/tests/`.
- Bridge ping/pong: `echo '{"type":"ping","id":"abc"}' | uv run gosai-bridge`
  produces `{"type":"ready"...}` then `{"type":"pong","id":"abc"...}`.
- `uv run ruff check src` is clean.

## What's Intentionally NOT Built Yet

- IPC subscription/broadcast logic on the WebSocket (Phase 2).
- Driver manager that spawns and supervises the Python bridge (Phase 2).
- App lifecycle, installer, manifest discovery (Phase 2).
- Logging persistence and streaming (Phase 2).
- System monitor (Phase 2).
- Dashboard panels beyond connection status (Phase 3).
- Fullscreen app-host window spawning on a selected display (Phase 3).
- Embedded terminal (Phase 3).
- SDK runtime API (Phase 4).

## Conventions Next Agents Must Follow

1. **Imports**: From workspace packages use `@gosai/shared`,
   `@gosai/shared/protocol`, `@gosai/shared/types`, `@gosai/shared/events`.
2. **TypeScript paths**: All new packages must extend `tsconfig.base.json`
   and add themselves as a reference in the root `tsconfig.json` if they're
   typechecked from the workspace root.
3. **No `any`**: strict mode is enforced; use `unknown` and narrow.
4. **Logs**: Never `console.log` in production paths. The logger lands in
   Phase 2; in the meantime, comments mark intentional `console.log`s
   (boot lines only).
5. **Paths**: All persistent data goes under `GosaiPaths` from
   `@gosai/server/paths`. Apps get isolated subdirectories under
   `paths.apps/<slug>/{config,data}`.
6. **Ports**: 7777 (server), no other ports yet. Anything new must be
   documented here.
7. **Process spawning**: When Phase 2 adds the Python bridge, use
   `Bun.spawn` (not `child_process`) so we stay on Bun's native APIs.
8. **Electron**: keep `contextIsolation: true`, `nodeIntegration: false`,
   `sandbox: true` as in `src/main/index.ts`.

## Open Items for Phase 2

- Implement WebSocket subscription/dispatch in `packages/server/src/ipc/`.
- Implement `DriverManager` and `PythonBridge` in
  `packages/server/src/drivers/`.
- Implement `AppManager`, `AppInstaller`, manifest validation in
  `packages/server/src/apps/`.
- Implement `Logger` with disk rotation + WebSocket streaming.
- Implement `SystemMonitor` for CPU/memory + driver loop times.
- Replace the echo handler in `server.ts` with the real router.
