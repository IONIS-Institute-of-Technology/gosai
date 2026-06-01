# @gosai/sdk

Official SDK for building GOSAI apps and experiences.

## Concepts

- **App**: a unit installed into GOSAI. One git repository = one app.
- **Experience**: a single fullscreen-runnable interaction within an app.
  An app can declare multiple experiences and switch between them at runtime.
- **Driver**: a Python module that produces real-time data (camera frames,
  hand landmarks, audio chunks). Apps subscribe to drivers via the SDK.
- **Manifest** (`gosai.app.json`): declares the app and its experiences.

## App Layout

```
my-app/
├── gosai.app.json
├── package.json         # has "@gosai/sdk": "*" as a dep
├── src/
│   └── experiences/
│       └── main.ts      # exports a `defineExperience` default
├── python/              # optional, if you ship Python drivers/processors
└── dist/                # built output (referenced by manifest entry)
```

A starter template is at `templates/basic/` in the GOSAI repo.

## Manifest Reference

```jsonc
{
  "slug": "my-app", // kebab-case unique identifier
  "name": "My App",
  "version": "0.1.0",
  "description": "...",
  "author": "you",
  "icon": "./assets/icon.png",
  "experiences": [
    {
      "slug": "main", // unique within this app
      "name": "Main",
      "description": "...",
      "entry": "dist/main.js", // ESM module, browser target
      "python": "python/main.py", // optional
      "drivers": ["hand_pose"], // auto-started + auto-subscribed
      "exclusive": false, // closes other experiences when started
      "allowed": [], // experiences allowed to co-run when exclusive
      "required": [], // experiences that must also be running
    },
  ],
  "python": {
    "requirements": "python/requirements.txt",
  },
  "startup": ["main"],
  "requirements": {
    // device slots this app binds (per app)
    "display": true, // opens a window (fullscreen/windowed)
    "camera": true, // exclusive: this app gets its own camera
    "microphone": false, // exclusive
    "speaker": false, // shareable across apps
  },
}
```

### Devices & bindings

Apps run in parallel, each bound to its own devices (the _binding_ is the app
slug). The top-level `requirements` object declares which device slots an app
needs; the dashboard then lets the operator assign a concrete camera /
microphone / speaker / display per app, persisted to
`paths.apps/<slug>/_config/settings.json`.

- `camera` / `microphone` are **exclusive** — each app gets its own device.
- `speaker` and device-less drivers (`heartbeat`) are **shared** across apps.

This is transparent to app code: `rt.drivers.on('camera', ...)` always resolves
to _your_ app's bound camera. The SDK subscribes to a per-app event topic and
tags requests with the binding for you.

## Experience API

```ts
import { defineExperience } from '@gosai/sdk';

export default defineExperience<State>({
  slug: 'main',
  name: 'Main',
  description: 'optional',

  init() {
    /* sync setup, runs before `start` */ return state;
  },

  async start(rt, state) {
    /* one-shot setup */
  },

  render(rt, state, frame) {
    /* per-rAF; optional */
  },

  async stop(rt, state) {
    /* cleanup */
  },
});
```

The runtime context (`rt`) provides:

| Property                                    | Description                                                     |
| ------------------------------------------- | --------------------------------------------------------------- |
| `rt.app.appSlug`, `rt.app.experienceSlug`   | identity                                                        |
| `rt.app.server`                             | underlying `ServerConnection` (advanced)                        |
| `rt.drivers.on(driver, event, listener)`    | subscribe to a driver event; returns `{ unsubscribe() }`        |
| `rt.drivers.get(driver, event)`             | get the most recent value for an event                          |
| `rt.drivers.execute(driver, action, data?)` | invoke a driver action                                          |
| `rt.storage.get/set/remove/list`            | per-app KV storage backed by `paths.apps/<slug>/_data/storage/` |
| `rt.log.debug/info/warn/error`              | logs routed to the GOSAI logger                                 |
| `rt.router.switchTo(slug)`                  | start another experience, stopping the current one              |
| `rt.router.stop(slug?)`                     | stop an experience (defaults to current)                        |

`FrameInfo` for `render`:

```ts
interface FrameInfo {
  timestamp: number; // performance.now()
  deltaMs: number; // since previous frame
  frameCount: number; // 0-based
}
```

## Renderer helpers

```ts
import { createCanvas, fitCanvas, fullscreenContainer } from '@gosai/sdk';

const container = fullscreenContainer();
const canvas = createCanvas(container);
const ctx = canvas.getContext('2d');
```

## Driver Data Types

Drivers publish typed events. Built-in driver shapes ship with the
GOSAI Python runtime; refer to each driver's source for the precise payload.
The `heartbeat` driver (always available) is great for testing:

```ts
rt.drivers.on('heartbeat', 'tick', (data) => {
  const t = data as { count: number; now: number };
});
```

Phase 6 will document the standard driver type bundle (camera, hand_pose,
pose, ball, microphone, etc.) as it lands.

## Build

GOSAI assumes app entries are ESM JavaScript with `@gosai/sdk` left as an
external. Bundle with bun or your bundler of choice:

```bash
bun build src/experiences/main.ts \
  --target=browser --format=esm \
  --outfile dist/main.js \
  --external @gosai/sdk
```

GOSAI serves the bundle at `http://127.0.0.1:7777/v1/apps/<slug>/static/<entry>`
and resolves `@gosai/sdk` via an import map injected by the app-host.

## Python Integration

When an experience declares `python: "..."`, the file is loaded into the
bridge process at experience start. Inside it, you can define a
`BaseProcessor` (Python-side companion):

```python
from gosai_py import BaseProcessor

class MyProcessor(BaseProcessor):
    name = "my-app:main:processor"
    subscribed = (("camera", "color"),)
    events = ("annotated_frame",)

    def on_data(self, driver, event, data):
        # data is a JSON-deserialized payload
        # do work, then publish results:
        self.emit("annotated_frame", { "found": 3 })
```

JS experience subscribers automatically receive `annotated_frame` events:

```ts
rt.drivers.on('my-app:main:processor', 'annotated_frame', (data) => { ... });
```

## Error Handling

- Throws inside lifecycle hooks are caught and logged; the experience moves
  to `crashed` state but the GOSAI server stays up.
- The render loop swallows exceptions per frame to keep the UI responsive.
- Network errors on driver subscriptions auto-retry on reconnect.

## Versioning

The SDK protocol version is exposed via `PROTOCOL_VERSION`. Backwards-
incompatible changes will bump this constant.
