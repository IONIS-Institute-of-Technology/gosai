# Phase 4 Summary - SDK and Application Framework

## Outcome

The GOSAI SDK is complete. App authors can write an experience as a
single TypeScript file, declare it in `gosai.app.json`, and ship it
either as a built bundle or in a git repo for installation. The runtime
loads experiences dynamically in the sandboxed app-host window, exposes
driver subscriptions, per-app storage, an experience router, and an app
logger that streams into the dashboard.

End-to-end verified: the basic template builds with `bun build`, installs
into a fresh GOSAI server, and starts via the WebSocket API. The
heartbeat driver subscription flows real-time events into the app, and
storage roundtrip works.

## What Was Built

### TypeScript SDK (`packages/sdk/src/`)

| File | Purpose |
|------|---------|
| `index.ts` | Public exports: `defineExperience`, `runExperience`, renderer helpers, types. |
| `types.ts` | All public types (`ExperienceDefinition`, `ExperienceRuntimeContext`, `DriverClient`, `StorageClient`, `AppLogger`, `ExperienceRouter`, `FrameInfo`, etc.) plus re-exports of `@gosai/shared` types. |
| `experience.ts` | `defineExperience` helper - small typed wrapper that produces an `ExperienceDefinition`. |
| `connection.ts` | `ServerClient`: auto-reconnecting WebSocket, lazy subscribe-on-listen, RPC with timeouts, dispatched events by exact name + namespace wildcard + `*`. |
| `driver-client.ts` | `DriverClientImpl`: maps `drivers.on(name, event, cb)` to server subscriptions + local event-driven dispatch. |
| `storage.ts` | `StorageClientImpl`: REST-backed per-app key/value store. |
| `logger.ts` | `AppLoggerImpl`: forwards entries to the server via `app:log` RPC. |
| `experience-router.ts` | `ExperienceRouterImpl`: tracks current experience, lets apps switch between experiences programmatically. |
| `runtime.ts` | `runExperience`: connect WS, build the runtime context, drive the lifecycle (`init` -> `start` -> render loop -> `stop`), handle cleanup. |
| `renderer.ts` | DOM helpers for fullscreen canvas creation. |

The SDK builds two artifacts:
- `dist/index.d.ts` etc. for TypeScript consumers via `workspace:*`.
- `dist/browser.js` (14.5 KB ESM) served by the GOSAI server at
  `/sdk-runtime.js` and used as an import-map target by app-host pages.

### Server additions (`packages/server/src/`)

| Change | Description |
|--------|-------------|
| `apps/storage.ts` | `AppStorage`: per-app JSON KV under `paths.apps/<slug>/_data/storage/`, with key sanitisation to prevent path traversal. |
| `server.ts` (REST endpoints) | `GET/POST/DELETE /v1/apps/:slug/storage/:key`, `GET /v1/apps/:slug/storage` (list keys). |
| `server.ts` (static files) | `GET /v1/apps/:slug/static/*`: serves any file from an installed app's directory with MIME guessing and path-traversal protection. |
| `server.ts` (sdk runtime) | `GET /sdk-runtime.js`: serves the SDK browser bundle so apps can import `@gosai/sdk` via import map. |
| `server.ts` (app:log handler) | New WS RPC handler that re-emits app log entries through the central `Logger`. |

### Python SDK additions (`python/src/gosai_py/`)

| File | Purpose |
|------|---------|
| `processor.py` | `BaseProcessor`: subclass of `BaseDriver` that auto-subscribes to `(driver, event)` pairs and exposes `on_data(driver, event, data)`. App-shipped Python processors extend this. |
| `serialization.py` | `to_msgpack` / `from_msgpack`, `frame_to_jpeg_base64`, `frame_to_png_base64`. Heavy-frame transport helpers. |
| `__init__.py` | Now re-exports `BaseDriver`, `BaseProcessor`, `DriverContext`. |

### App-host runtime (`packages/desktop/src/renderer/`)

| File | Change |
|------|--------|
| `app-host.html` | Adds an `importmap` that resolves `@gosai/sdk` to `http://127.0.0.1:7777/sdk-runtime.js`. CSP allows scripts and images from the local server. |
| `app-host/AppHost.tsx` | Reads `?app=` and `?experience=` query params, fetches the app catalogue, dynamically `import()`s the experience module from `/v1/apps/.../static/<entry>`, then calls `runExperience` from the SDK runtime. |

### Template (`templates/basic/`)

A `hello-gosai` app demonstrating:

- Lifecycle (`init`, `start`, `render`, `stop`).
- Driver subscription (`heartbeat.tick`).
- Storage roundtrip (`last-tick` value persisted on `beforeunload`).
- Logger.
- Canvas rendering with FPS-style animation.

Build via `bun build src/main.ts --target=browser --format=esm --outfile dist/main.js --external @gosai/sdk` (1.96 KB output).

### Documentation

- `packages/sdk/README.md` is the complete API reference: concepts,
  layout, manifest schema, lifecycle, runtime API, renderer helpers,
  driver data types, build command, Python integration, error handling.
- `templates/basic/README.md` is the getting-started guide.

## Verified Working

- `bun run typecheck` clean across all packages.
- `bun test` in `packages/server`: 13 tests pass.
- `bun packages/server/test/smoke-e2e.ts`: heartbeat plumbing still works.
- `bun packages/server/test/phase4-e2e.ts`: NEW.
  1. Symlinks the template app, server discovers it via the manifest.
  2. `/sdk-runtime.js` serves the 14.5 KB SDK bundle with `runExperience` in it.
  3. `/v1/apps/hello-gosai/static/dist/main.js` serves the 1.95 KB built app
     module which references `defineExperience`.
  4. Storage POST/GET/DELETE/LIST all work and persist to disk.
  5. WebSocket `experience:start` succeeds and broadcasts
     `experience:state-changed` (state `running`).
  6. Heartbeat driver auto-starts and `driver:event` flows to the client.
  7. `experience:stop` cleans up.
- `bun run --filter '@gosai/*' build` produces:
  - SDK: `dist/index.js`, `dist/browser.js` (14.58 KB)
  - Server: `dist/index.js` (~120 KB)
  - Desktop: full out/ tree
  - Template: `templates/basic/dist/main.js` (1.96 KB)
- `uv run pytest -q`: passes (2 tests).
- `uv run ruff check src`: clean.

## Conventions Locked In

1. **App entry**: ESM JS module whose default export is the result of
   `defineExperience(...)`. Bundle with `--external @gosai/sdk`.
2. **Module resolution**: the GOSAI server hosts the SDK at
   `/sdk-runtime.js` and resolves `@gosai/sdk` for apps via an
   `importmap` in the app-host HTML.
3. **Storage**: per-app JSON KV at `paths.apps/<slug>/_data/storage/<key>.json`.
   Keys must match `/^[a-zA-Z0-9._-]+$/`.
4. **Static assets**: anything inside an installed app directory is served
   at `/v1/apps/<slug>/static/<path>` with MIME guessing.
5. **Logging**: apps log via `rt.log.*` which sends `app:log` over WS.
   The server re-emits through `Logger`, so app logs show up in the
   dashboard logs panel alongside server logs.
6. **Python processors**: subclass `BaseProcessor`, declare
   `subscribed: tuple[tuple[str, str], ...]` and `events: tuple[str, ...]`,
   override `on_data` and call `self.emit(event, data)`.
7. **Driver naming for processors**: convention is
   `<app-slug>:<experience-slug>:processor` to avoid collisions.

## Known Limitations (deferred)

- The app-host does not yet load Python processors automatically. The
  `experience.python` manifest field is parsed and stored, but starting an
  experience does not yet wire the processor. Phase 5 will close this.
- Hot reload of experiences during development is not implemented; apps
  must rebuild between iterations.
- The import map approach requires `script-src 'unsafe-inline'` in the CSP
  for the inline `<script type="importmap">`. This is acceptable because
  the file is loaded over `file://` from the bundled app and the source is
  fixed. Phase 7 can move the importmap to an external file referenced by
  hash, eliminating the `unsafe-inline` allowance.
- No `gosai create` CLI to scaffold new apps yet (you copy the template);
  Phase 7 may add one.

## Open Items for Phase 5

- Add the calibration app under `apps/calibration/` (using this SDK).
- Add the `calibration` and `camera` Python drivers.
- Wire `experience.python` so a manifest-declared Python processor is
  loaded into the bridge process at experience start and unloaded at stop.
- Persist calibration matrices via `rt.storage`.
- Document calibration data types (homography, focus matrix) for apps to
  read.
