# Phase 3 Summary - Electron Desktop Application

## Outcome

A complete Electron desktop application built with electron-vite + React 19 +
Tailwind v4. Connects to the GOSAI server over WebSocket, manages a primary
dashboard window plus zero-or-more fullscreen app-host windows on any chosen
display, embeds a full xterm.js terminal backed by node-pty, and surfaces all
server state (apps, drivers, experiences, logs, config, system stats) in a
clean dark-themed UI.

## What Was Built

### Main Process (`src/main/`)

| File               | Purpose                                                                                                                                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `index.ts`         | Boot sequence: create registries, register IPC, open dashboard, lifecycle handlers (SIGTERM, before-quit cleanup). Optional autostart of the GOSAI server when packaged.                                           |
| `windows.ts`       | `WindowRegistry`: dashboard window (1280x800, dark chrome, autohide menu) + N fullscreen frameless kiosk-mode app-host windows positioned by display id. Provides display enumeration via Electron's `screen` API. |
| `terminal.ts`      | `TerminalRegistry`: node-pty backed terminal manager (shell = `$SHELL` on POSIX, `powershell.exe` on Windows). Emits `data` and `exit` events.                                                                     |
| `ipc.ts`           | All IPC channel handlers using `ipcMain.handle`. Routes display queries, app-host open/close/list, terminal create/write/resize/dispose, and forwards terminal data/exit events to the originating WebContents.    |
| `channels.ts`      | Single source of truth for IPC channel names, importable from main and preload.                                                                                                                                    |
| `server-runner.ts` | Optional child-process launcher for the GOSAI server. Active only when packaged or when `GOSAI_AUTOSTART_SERVER=1`. Phase 7 will wire this to the bundled binary.                                                  |

### Preload Scripts (`src/preload/`)

| File           | Exposed API (via contextBridge)                                                                                                                          |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dashboard.ts` | `window.gosai`: version, platform, displays (`list`), appHost (`open`/`close`/`list`), terminal (`create`/`write`/`resize`/`dispose`/`onData`/`onExit`). |
| `app-host.ts`  | `window.gosaiApp`: version, platform (more in Phase 4).                                                                                                  |

Both preloads use `contextBridge.exposeInMainWorld` with `contextIsolation: true`. Dashboard runs without sandbox because it spans node-pty IPC traffic; app-host runs **with** sandbox enabled for isolation.

### Renderer (`src/renderer/`)

```
src/renderer/
├── dashboard.html         # CSP-locked entry
├── app-host.html          # CSP-locked entry
└── src/
    ├── styles.css         # Tailwind v4 with theme tokens
    ├── types.d.ts         # Window.gosai / Window.gosaiApp
    ├── lib/
    │   ├── server-client.ts     # Auto-reconnecting WebSocket client
    │   │                          (subscribe/RPC/dispatch with 1s reconnect)
    │   └── server-context.tsx   # React context + hooks (useServer)
    ├── dashboard/
    │   ├── main.tsx              # createRoot entry
    │   ├── Dashboard.tsx         # Sidebar shell + status bar
    │   ├── SystemHeader.tsx
    │   ├── components/
    │   │   ├── Panel.tsx
    │   │   └── EmptyState.tsx
    │   └── panels/
    │       ├── AppsPanel.tsx     # Install via git URL, grid of apps
    │       │                       with start/stop per experience, uninstall
    │       ├── DriversPanel.tsx  # Sortable table of drivers + state
    │       ├── ExperiencesPanel.tsx # Running experiences + app windows
    │       ├── LogsPanel.tsx     # Filterable log stream (text, level, auto-scroll)
    │       ├── TerminalPanel.tsx # xterm.js + fit addon, node-pty backed
    │       └── SettingsPanel.tsx # Display chooser + global config view
    └── app-host/
        ├── main.tsx
        └── AppHost.tsx           # Phase 4 will load actual experience modules here
```

### Build configuration

| File                            | Notes                                                                                                                                                      |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `electron.vite.config.ts`       | Three sub-builds: main (Lib SSR), preload (CJS, separate dashboard + appHost entries), renderer (Vite, two HTML entries with React + Tailwind v4 plugins). |
| `tsconfig.{json,node,web}.json` | Already correct from Phase 1; renderer config does not pull in main/preload, types.d.ts uses inline declarations.                                          |
| `package.json`                  | Added `node-pty@^1.0.0`, `@xterm/xterm@^5.5.0`, `@xterm/addon-fit@^0.10.0`.                                                                                |

## Behavior the User Can See

- Sidebar navigation between Apps, Experiences, Drivers, Logs, Terminal, Settings.
- Status bar at the bottom shows connection status, OS platform, live CPU%, memory usage, server uptime - all polled from `system:stats` events.
- Apps panel: install a remote git repo, see installed apps with built-in tags, expand experiences, start/stop them. Starting an experience also opens an app-host fullscreen window on the chosen (or primary) display.
- Experiences panel: list running experiences + the corresponding app-host windows. Stop / kill independently.
- Drivers panel: live table of drivers, their state, events they publish, dependencies, and subscriber count - updates in real time via `drivers:list-changed`.
- Logs panel: tail-able log stream with filter-by-text, filter-by-level, auto-scroll toggle, clear button. Pulls history on mount and subscribes to `server:log`.
- Terminal panel: a real interactive shell (zsh on this host) inside xterm.js, full key handling, auto-resize on container resize via FitAddon.
- Settings panel: list of displays detected by Electron, click to select the rendering display; current config snapshot.
- App-host window: opens frameless+kiosk+fullscreen on the selected display, runs sandboxed, ready for Phase 4 to load experience code.

## Verified Working

- `bun run typecheck` clean across all packages.
- `bun run --filter @gosai/desktop build` produces:
  - `out/main/index.js` (8.89 kB)
  - `out/preload/dashboard.cjs` (1.87 kB), `out/preload/appHost.cjs` (0.18 kB)
  - `out/renderer/dashboard.html`, `out/renderer/app-host.html`, dashboard chunk (459 kB - mostly xterm), styles (~22 kB), app-host chunk (0.68 kB).
- node-pty prebuilt binaries are present for darwin-arm64, darwin-x64, win32-arm64, win32-x64 - no native rebuild required for dev on Apple Silicon.

## Conventions

1. **Server traffic** is direct from the renderer to `ws://127.0.0.1:7777/ws` using `ServerClient`. The main process is _not_ a relay for normal server data - that would add latency and complexity. Main is only in the path for things that need Node APIs (display info, window creation, terminal pty).
2. **IPC channel names** live in `src/main/channels.ts`. Anything new must go there.
3. **Re-subscribing on reconnect**: `ServerClient` remembers subscribed events and re-sends `subscribe` on reconnect.
4. **Display selection**: `Settings -> Display` writes to `GlobalConfig.displayId`. The Apps panel's start handler reads it (via `gosai.displays.list()`); when no preference is set it falls back to primary. Future: present a chooser dialog when the user has multiple displays and hasn't picked one.
5. **Window cleanup**: Closing the dashboard kills all terminal pty processes and closes all app-host windows. The before-quit handler also gives the embedded server (if any) a chance to stop cleanly.
6. **Sandbox**: app-host windows have `sandbox: true` and `contextIsolation: true`; experiences can't reach Node APIs. They communicate with the server over WebSocket using the SDK (Phase 4).

## Known Limitations (deferred)

- The app-host window currently displays a placeholder. Phase 4 will load
  the experience entry module inside it via the SDK.
- Display chooser dialog when multiple displays are present is not implemented;
  defaults to primary.
- The terminal panel creates exactly one terminal; multi-tab terminals are
  out of scope for Phase 3.
- The performance/FPS panel is reduced to the status bar; richer charts can
  be added later (Recharts or similar) without architectural changes.
- node-pty native binary for Electron's ABI requires `electron-rebuild` if
  Electron's Node ABI differs from the prebuild. Phase 7 will add a postinstall
  step.

## Open Items for Phase 4

- Build the SDK (`@gosai/sdk`) so that experience code loaded in the
  app-host window can subscribe to driver events, render to canvas, switch
  experiences, and persist storage.
- Define the Python SDK (`gosai_py` extensions) for app-shipped drivers.
- Build the basic app template in `templates/basic`.
- Wire the app-host page to dynamically import the experience entry module
  resolved from the `gosai.app.json` installed in `paths.apps/<slug>/`.
