# @gosai/sdk

TypeScript SDK for building GOSAI apps.

- An **app** is a directory (usually a git repository) with a `gosai.app.json`
  manifest. GOSAI installs it and serves its files.
- An **experience** is one runnable interaction in an app. It runs in its own
  window, usually fullscreen on a projector or display.
- A **driver** is a Python module in the GOSAI runtime that produces live data
  (camera frames, hand landmarks, audio analysis) and accepts actions. Apps
  subscribe to drivers through the SDK.

The package has two entries:

| Import            | For                                                                                                                   |
| ----------------- | --------------------------------------------------------------------------------------------------------------------- |
| `@gosai/sdk`      | App code: `defineExperience`, the runtime context types, layers, canvas, warp, homography and calibration helpers.    |
| `@gosai/sdk/host` | Code that hosts experiences: `runExperience`, `ServerClient`, protocol constants and server types such as `LogEntry`. |

A starter app lives in [`templates/basic`](../../templates/basic).

## Manifest

```jsonc
{
  "slug": "my-app", // lowercase letters, digits and dashes, at most 63 characters
  "name": "My App",
  "version": "0.1.0",
  "description": "What the app does",
  "author": "you",
  "default": "main", // experience the dashboard launches; defaults to the first one
  "experiences": [
    {
      "slug": "main",
      "name": "Main",
      "description": "Shown as rt.app.experience.description",
      "entry": "dist/main.js", // browser ESM module, relative to the app root
      "drivers": ["hand_pose"], // started with the experience
      "exclusive": false, // stop the app's other experiences when this one starts
      "allowed": [], // experiences an exclusive experience keeps running
      "required": [], // experiences started together with this one
    },
  ],
  "requirements": {
    "display": true, // opens a window
    "camera": true, // this app gets its own camera
    "microphone": false, // this app gets its own microphone
    "speaker": false, // shared between apps
  },
  "calibration": {
    "required": true,
    "entry": "dist/calibration.js",
    "statusKey": "calibration_status",
  },
  "settings": {
    "storageKey": "config", // default
    "groups": [
      {
        "label": "Display",
        "fields": [
          {
            "key": "display.fit", // dotted path into the settings object
            "label": "Screen fit",
            "type": "select", // boolean | number | string | select
            "default": "contain",
            "options": [
              { "value": "contain", "label": "Contain" },
              { "value": "cover", "label": "Cover" },
            ],
          },
          {
            "key": "display.zoom",
            "label": "Zoom",
            "type": "number",
            "min": 0.5,
            "max": 3,
            "default": 1,
          },
        ],
      },
    ],
  },
}
```

`requirements` drives the per-app device pickers in the dashboard. Device
choices are applied to your drivers automatically: `rt.drivers.on('camera', ...)`
always reaches the camera assigned to your app.

## Experiences

The module named by `entry` default-exports an experience. Every hook is
optional.

```ts
import { createFullscreenCanvas, defineExperience, type FullscreenCanvas } from '@gosai/sdk';

interface State {
  view: FullscreenCanvas;
  hands: number;
}

export default defineExperience<State>({
  // Runs once and builds the state the other hooks receive.
  init(rt) {
    return {
      view: createFullscreenCanvas({ reference: { width: 1920, height: 1080 }, signal: rt.signal }),
      hands: 0,
    };
  },

  // Runs when the experience becomes active.
  start(rt, state) {
    rt.drivers.on('hand_pose', 'raw_data', (data) => {
      state.hands = (data as { hands_landmarks?: unknown[] }).hands_landmarks?.length ?? 0;
    });
  },

  // Runs every animation frame.
  render(rt, state, frame) {
    const { ctx } = state.view;
    state.view.fit();
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, 1920, 1080);
  },

  // Runs when the experience stops, including when its window closes.
  async stop(rt, state) {
    await rt.storage.set('last-hands', state.hands);
  },
});
```

The name, description and slug come from the manifest, not from the module.

`frame` has `timestamp` (comparable with `performance.now()`), `frameCount`,
and `deltaMs`, the time since the previous frame capped at 100 ms so a stall
doesn't make motion jump. Scale motion by `deltaMs` rather than per frame.

If `render` throws, the runtime logs each distinct error once. After 60
consecutive failing frames it stops the experience and the window shows the
error. If `init` or `start` throws, the runtime calls `stop` (when `init`
succeeded), releases everything and shows the error.

### Cleanup

When the experience stops, the runtime:

- removes every `rt.drivers.on` and `rt.events.on` subscription still open,
- aborts `rt.signal`,
- closes `rt.audio` and the server connection.

Pass `rt.signal` to anything else that accepts one:

```ts
window.addEventListener('keydown', onKey, { signal: rt.signal });
const res = await fetch(url, { signal: rt.signal });
```

Release other resources (WebGL renderers, media elements) in `stop`.

## Runtime context

| Member                                         | Description                                                                          |
| ---------------------------------------------- | ------------------------------------------------------------------------------------ |
| `rt.app.appSlug`, `rt.app.experienceSlug`      | Identity.                                                                            |
| `rt.app.manifest`, `rt.app.experience`         | The parsed manifest and this experience's entry in it.                               |
| `rt.app.params`                                | Launch parameters of the window, such as `role` and `target` for calibration.        |
| `rt.drivers.on(driver, event, listener)`       | Subscribe to a driver event. Returns `{ unsubscribe() }`.                            |
| `rt.drivers.get<T>(driver, event)`             | Latest value of a driver event.                                                      |
| `rt.drivers.execute<T>(driver, action, data?)` | Run a driver action and get its result.                                              |
| `rt.storage.get<T>(key, fallback?)`            | Read a JSON value. Returns `T` when you pass a fallback, `T \| undefined` otherwise. |
| `rt.storage.set(key, value)`, `remove`, `list` | Per-app key/value storage.                                                           |
| `rt.settings.get<T>()`                         | Settings from the manifest schema: stored values merged over the defaults.           |
| `rt.settings.set({ 'display.zoom': 2 })`       | Store settings by dotted key. Keys you don't set keep following their default.       |
| `rt.assets.url(path)`                          | URL of a file in the app, relative to the app root, e.g. `assets/logo.png`.          |
| `rt.events.emit(topic, data)`, `rt.events.on`  | Messages between windows of the same app, e.g. a projector and a control window.     |
| `rt.log.debug/info/warn/error(message, data?)` | Logs shown in the dashboard's Logs panel.                                            |
| `rt.audio`                                     | An `AudioContext` created on first use and resumed when the experience starts.       |
| `rt.ping()`                                    | Round-trip time to the server, in milliseconds.                                      |
| `rt.signal`                                    | Aborts when the experience stops.                                                    |
| `rt.router.switchTo(slug)`, `rt.router.stop()` | Start or stop experiences of this app on the server. It doesn't open windows yet.    |
| `rt.app.server`                                | The raw server connection, for commands the SDK doesn't wrap.                        |

## Layers

`LayerManager` runs independent modules inside one experience: a menu,
overlays, launchable scenes.

```ts
import { LayerManager, type LayerDefinition } from '@gosai/sdk';

interface Frame {
  ctx: CanvasRenderingContext2D;
  deltaMs: number;
}

const layers = new LayerManager<Frame>(
  [
    { slug: 'menu', zIndex: 100, persistent: true, create: () => createMenu() },
    { slug: 'hands', zIndex: 50, create: () => createHands() },
    { slug: 'game', exclusive: true, allowed: ['hands'], create: () => createGame() },
  ],
  {
    onError: (slug, err, phase) =>
      rt.log.warn(`layer ${slug} ${phase} failed`, { err: String(err) }),
  },
);

await layers.start('menu');
layers.render({ ctx, deltaMs: frame.deltaMs }); // in render
await layers.stopAll(); // in stop
```

- A layer has optional `preload`, `start`, `render`, `stop`, `suspend` and
  `resume` hooks. It renders once `start` has resolved, in `zIndex` order.
- Starting an exclusive layer stops every other layer except persistent ones,
  its `allowed` list and its `required` list, then starts the required ones.
- Persistent layers ignore `stop(slug)` unless you pass `{ force: true }`.
- Stopping a layer while its `start` is still running stops it as soon as
  `start` returns; it never renders.
- `suspend()` pauses rendering and calls each running layer's `suspend` hook,
  for example to hide a WebGL canvas or mute audio. `resume()` undoes it.
- A layer whose `render` keeps throwing is reported once and stopped after 30
  consecutive failures.
- Extra fields on definitions (labels, icons) are kept and typed:
  `new LayerManager<Frame, MyDefinition>(...)`.

## Canvas

```ts
const view = createFullscreenCanvas({
  reference: { width: 1080, height: 1920 }, // your drawing coordinates
  mode: 'contain', // contain | cover | stretch
  signal: rt.signal, // remove the canvas when the experience stops
});

// Each frame:
view.fit(); // resizes the backing store if needed and maps reference coordinates onto the window
view.ctx.fillRect(0, 0, 1080, 1920);
```

`fitCanvas(canvas)` sizes a canvas's backing store to its CSS box times the
device pixel ratio, and only touches it when the size changed.
`computeFit(target, reference, mode)` returns the scale and offset without
touching a canvas. `createCanvas(parent)` and `fullscreenContainer()` remain
for simple cases.

## Projection helpers

`applyQuadWarp(element, quad)` maps an element's box onto a quadrilateral with
a CSS `matrix3d` transform, for example to land a canvas on a table seen by a
tilted projector. `clearQuadWarp(element)` restores the element's previous
styles.

The homography functions work with 3x3 row-major matrices, the same layout as
OpenCV:

- `perspectiveTransformPoint(H, x, y)` returns `null` when the point maps to
  infinity. `perspectiveTransformPoints(H, points)` keeps indices.
- `quadToQuadHomography(src, dst)`, `invertHomography(H)`,
  `multiplyHomographies(A, B)` and `computeCSSMatrix3d(width, height, quad)`.

## Calibration

Declare a calibration entry in the manifest and default-export a definition:

```ts
import { createCameraProjectorSurfaceCalibration } from '@gosai/sdk';

export default createCameraProjectorSurfaceCalibration({
  name: 'My Surface Calibration',
  surfaceSize: { width: 1920, height: 1080 },
});
```

The built-in calibration app loads it and writes the result into your app's
storage. Read it back with `loadCameraProjectorSurfaceCalibration(rt)`.

## Driver data

Driver payloads are untyped for now; cast them to the shape the driver emits.
The `heartbeat` driver ticks steadily and is handy for testing:

```ts
rt.drivers.on('heartbeat', 'tick', (data) => {
  const { count } = data as { count: number; now: number };
});
```

## Building

Bundle each entry as browser ESM and leave `@gosai/sdk` external:

```bash
bun build src/main.ts --target=browser --format=esm --outfile dist/main.js --external @gosai/sdk
```

GOSAI runs each app on its own origin, `http://<slug>.localhost:<port>`. The
page there has an import map that resolves `@gosai/sdk` to the server's copy
of the SDK, fetches your manifest, imports your entry and runs it. Files in
your app are served under `/v1/apps/<slug>/static/`; use `rt.assets.url` to
build their URLs.

The page's Content Security Policy allows scripts, styles, images, media and
fonts from the app origin, `data:` and `blob:` URLs for media, WebAssembly,
and network connections to the app origin or to `https:` and `wss:` URLs.
Inline scripts, inline `style` attributes set through HTML or `setAttribute`,
and plain `http:` or `ws:` connections to other hosts are blocked. Setting
`element.style` properties from code works.
