# hello-gosai

Minimal GOSAI app. It draws a dot circling the screen, counts `heartbeat`
driver ticks, keeps the count in storage and reads its color from settings.

## Structure

```
hello-gosai/
├── gosai.app.json   # manifest: SDK range, experiences, requirements, settings
├── package.json     # build script, and @gosai/sdk and TypeScript as dev dependencies
├── tsconfig.json
└── src/
    └── main.ts      # the experience
```

## Build

```bash
bun install
bun run typecheck
bun run build
```

`build` bundles `src/main.ts` into `dist/main.js`, the `entry` the manifest
names. `@gosai/sdk` stays external: GOSAI provides its own copy when it runs
the app, so the build needs nothing installed.

`@gosai/sdk` and TypeScript are dev dependencies, only for your editor and
`bun run typecheck`. When GOSAI installs the app from git it runs
`bun install --production`, which skips them, and only when the app has
runtime `dependencies` (libraries your build bundles, such as `three`). Commit
`bun.lock` and GOSAI installs exactly those versions.

The manifest's `"sdk": "^0.1.0"` says which SDK versions the app works with.
Keep it in step with the `@gosai/sdk` range in `package.json`: GOSAI refuses to
install the app when the SDK it serves is outside the manifest's range.

## Run it in GOSAI

- **Install from git.** Push the directory to a repository and paste its URL
  in the dashboard's Apps tab. GOSAI clones it, installs runtime dependencies
  if there are any, and runs `bun run build`.
- **Kiosk.** Run one built app without the dashboard, from the GOSAI
  repository: `bun run kiosk <path-to-this-directory>`. See the kiosk section
  of the root README.

Apps are discovered when the server starts, so restart GOSAI after adding one
by hand to its apps directory.

## What `src/main.ts` shows

- `init(rt)` builds the state: a fullscreen canvas removed automatically when
  the experience stops (`signal: rt.signal`), settings merged with the
  manifest defaults, and a counter read from storage with a typed fallback.
- `start` subscribes to a driver. The runtime removes the subscription on stop,
  and the tick payload is typed from the driver's schema.
- `render` scales motion by `frame.deltaMs` and draws in a 1920x1080 reference
  space that `fit()` maps onto the window.
- `stop` saves the counter.

## Network access

The app window may connect to its own origin and to any `https:` or `wss:`
URL. To reach a plain `http:` or `ws:` service, such as a device on the local
network, list its origin in `gosai.app.json`:

```json
"network": { "connect": ["ws://relay.local:8080"] }
```

Blocked requests appear in the dashboard's Logs panel.

See the [SDK README](https://github.com/IONIS-Institute-of-Technology/gosai/blob/master/packages/sdk/README.md)
for the manifest reference and the full runtime API, and the
[driver reference](https://github.com/IONIS-Institute-of-Technology/gosai/blob/master/docs/drivers.md)
for what each driver sends and accepts.
