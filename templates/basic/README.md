# hello-gosai

Minimal GOSAI app template.

## Structure

```
hello-gosai/
├── gosai.app.json   # manifest read by GOSAI
├── package.json     # bun build script + @gosai/sdk dep
├── tsconfig.json
└── src/
    └── main.ts      # the experience entry
```

## Build

```bash
bun install
bun run build
```

The `build` script bundles `src/main.ts` into `dist/main.js` as a browser
ESM module. `@gosai/sdk` is marked as external; GOSAI provides it at
runtime via `http://127.0.0.1:7777/sdk-runtime.js` and resolves the
`@gosai/sdk` specifier in your bundle through an import map injected by the
app-host.

## Install into GOSAI

If you push this directory to a git repo, GOSAI can install it via the
dashboard's `Install` form (paste the repository URL).

For local development, copy or symlink this directory into
`~/.gosai/apps/hello-gosai/` and refresh the dashboard.

## What it does

The experience opens a fullscreen canvas, subscribes to the GOSAI
`heartbeat` driver's `tick` event, and renders a bouncing dot annotated with
the current tick count and elapsed time.

## Manifest reference

```jsonc
{
  "slug": "hello-gosai",      // required, kebab-case
  "name": "Hello GOSAI",       // required, human-readable
  "version": "0.1.0",          // required
  "description": "...",
  "author": "GOSAI",
  "icon": "./assets/icon.png", // optional, served via /v1/apps/.../static/...
  "experiences": [             // at least one required
    {
      "slug": "main",          // required, kebab-case unique per app
      "name": "Main",
      "description": "...",
      "entry": "dist/main.js", // ESM module relative to app root
      "python": "src/main.py", // optional Python processor module
      "drivers": ["heartbeat"],// drivers auto-started for this experience
      "exclusive": false,      // if true, stops other non-allowed experiences
      "allowed": [],           // experiences that can co-run when exclusive
      "required": []           // experiences that must also be running
    }
  ],
  "python": {                  // optional python deps for the app
    "requirements": "requirements.txt"
  },
  "startup": ["main"]          // experiences to autostart
}
```

## SDK Quick reference

```ts
import { defineExperience } from '@gosai/sdk';

export default defineExperience<MyState>({
  slug: 'main',
  name: 'Main',

  init(): MyState { /* synchronous setup */ },

  async start(rt, state) {
    rt.drivers.on('camera', 'color', (frame) => { /* ... */ });
    await rt.storage.set('foo', 42);
    rt.log.info('hello');
  },

  render(rt, state, frame) {
    // called every animation frame
  },

  async stop(rt, state) { /* cleanup */ },
});
```

The `rt` (runtime) object provides:
- `rt.drivers.on(driver, event, listener)` - subscribe to driver events
- `rt.drivers.get(driver, event)` - get latest value
- `rt.drivers.execute(driver, action, data)` - invoke driver actions
- `rt.storage.{get,set,remove,list}` - per-app KV storage
- `rt.log.{debug,info,warn,error}` - log to the GOSAI dashboard
- `rt.router.switchTo(experienceSlug)` - move to another experience
- `rt.app.appSlug` / `rt.app.experienceSlug` - this experience's identity
