# Phase 7 - Integration, Polish, Packaging

## Goal

Wire every layer together, validate end-to-end, harden the runtime, and
configure standalone packaging so GOSAI can be distributed as a single
installer.

## What landed

### App installation pipeline

`packages/server/src/apps/installer.ts` now does:

1. `git clone --depth 1` into a staging dir.
2. Manifest validation (`parseManifest`).
3. Move to `apps/<slug>/`.
4. `bun install --silent` if there are any non-SDK dependencies. The SDK
   itself is provided at runtime via the import map, so apps declaring
   only `@gosai/sdk` (workspace:* or otherwise) skip install gracefully.
5. `bun run build` if the app declares a build script.
6. `uv pip install -r <requirements>` if the manifest declares Python
   requirements.

Every step surfaces clear errors and the staging dir is always cleaned up
on failure. The dashboard's Apps panel already calls this through the
existing `app:install` RPC.

### Robustness

- `packages/server/src/server.ts` now catches `EADDRINUSE` from
  `Bun.serve` and rethrows a friendly error that names the host/port.
- The server's `index.ts` already handles SIGINT/SIGTERM and the
  `ServerRunner` on the desktop side already kills the embedded server
  with SIGTERM (timeout SIGKILL) on quit. Phase 7 added port-conflict
  detection on top.
- Pre-existing crash isolation (driver-level + experience-level) was
  re-validated with the Phase 7 e2e test.

### Packaging (electron-builder)

- `packages/desktop/electron-builder.config.cjs` configures macOS DMG
  (arm64 + x64) and Linux AppImage (x64) targets.
- `extraResources` bundles three things into the installed app:
  - the compiled GOSAI server binary at `Resources/server/gosai-server`,
  - the Python source tree at `Resources/python/` (excluding `.venv` and
    caches),
  - the built-in apps at `Resources/apps/`.
- The root `package.json` exposes:
  - `bun run build:server-bin` - `bun build --compile` on
    `packages/server/src/index.ts`, producing a single ~60 MB executable.
  - `bun run package:mac` / `bun run package:linux` - build everything +
    invoke electron-builder.

The compiled server binary was exercised against `GET /healthz` to make
sure the bundle starts cleanly.

### Dev experience

- Root `package.json` got `python:test`, `test`, and a `build:apps`
  convenience target. `bun run dev` already spans server + desktop with
  `concurrently`.
- The user's rule "never run the projects" was honoured throughout:
  builds + tests only, no long-running dev servers spawned by the agent.

### End-to-end validation

`packages/server/test/phase7-e2e.ts` exercises the entire app lifecycle:

1. Copies the workspace's `templates/basic` into a fresh git repo on
   disk.
2. Boots a clean server pointed at a tmp directory.
3. Calls `app:install` over WebSocket with a `file://` URL. The
   installer clones, validates, builds (`bun run build`), and catalogues
   the app.
4. Fetches the built `dist/main.js` via the server's static route to
   confirm packaging.
5. Calls `experience:start`, confirms the experience is listed as
   running.
6. Calls `experience:stop`, confirms the running list is empty.
7. Calls `app:uninstall`, confirms the app disappears.

The test runs in ~30 s on a warm cache and is green.

### Documentation

- `README.md` rewritten with the architecture diagram, requirements,
  script reference, manifest snippet, and links to the new docs.
- `docs/quick-start.md` - 5-minute developer guide (clone, sync,
  install your first app, write your own).
- `docs/deployment.md` - packaging and notarisation guide for macOS +
  Linux, plus a troubleshooting table.

## What's intentionally not in Phase 7

- **Python driver hot reload.** The bridge process boots once at server
  startup; restarting it for code changes requires restarting the
  server. Documented in the quick-start.
- **Windows installer.** Easy to add (`win:` block in
  electron-builder.config.cjs) but no Windows target was requested.
- **Signing / notarisation pipeline.** Hooks are documented in
  `docs/deployment.md`; the default config explicitly produces unsigned
  builds for development.
- **Auto-update.** electron-builder's auto-updater module isn't wired
  up; would be a follow-up that touches release infrastructure.

## Validation matrix

| Check                             | Result                                  |
| --------------------------------- | --------------------------------------- |
| `bun run typecheck`               | clean                                   |
| `bun run python:lint`             | clean                                   |
| `bun run python:test`             | 7 passed                                |
| Phase 5 e2e                       | green (calibration drivers + static)    |
| Phase 6 e2e                       | green (all 13 drivers discovered)       |
| Phase 7 e2e                       | green (install -> run -> stop -> uninstall) |
| `bun run build`                   | clean (all 4 TS packages + apps)        |
| `bun run build:server-bin`        | clean, 60 MB executable                 |
| `bun --filter @gosai/desktop run build` | clean (main + preload + renderer)  |
