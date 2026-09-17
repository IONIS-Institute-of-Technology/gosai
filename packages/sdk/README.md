# @gosai/sdk

TypeScript SDK for building GOSAI apps.

- An **app** is a directory (usually a git repository) with a `gosai.app.json`
  manifest. GOSAI installs it and serves its files.
- An **experience** is one runnable interaction in an app. It runs in its own
  window, usually fullscreen on a projector or display.
- A **driver** is a Python module in the GOSAI runtime that produces live data
  (camera frames, hand landmarks, audio analysis) and accepts actions. Apps
  subscribe to drivers through the SDK, and can ship drivers of their own (see
  [Python drivers](#python-drivers)).

## Install

```bash
bun add -d @gosai/sdk
```

The package holds the SDK's types and browser ESM bundles, with no runtime
dependencies. Install it as a dev dependency: apps build with `@gosai/sdk`
external (see [Building](#building)), and at runtime GOSAI serves its own copy
of the SDK to app windows. GOSAI refuses apps whose manifest `sdk` range doesn't
include that version.

The package has two entries:

| Import            | For                                                                                                                   |
| ----------------- | --------------------------------------------------------------------------------------------------------------------- |
| `@gosai/sdk`      | App code: `defineExperience`, the runtime context types, layers, canvas, warp, homography and calibration helpers.    |
| `@gosai/sdk/host` | Code that hosts experiences: `runExperience`, `ServerClient`, protocol constants and server types such as `LogEntry`. |

A starter app lives in [`templates/basic`](https://github.com/IONIS-Institute-of-Technology/gosai/tree/master/templates/basic).

## Manifest

```jsonc
{
  "slug": "my-app", // lowercase letters, digits and dashes, at most 63 characters
  "name": "My App",
  "version": "0.1.0",
  "sdk": "^0.1.0", // @gosai/sdk versions the app works with
  "description": "What the app does",
  "author": "you",
  "default": "main", // experience the dashboard launches; defaults to the first one
  "experiences": [
    {
      "slug": "main",
      "name": "Main",
      "description": "Shown as rt.app.experience.description",
      "entry": "dist/main.js", // browser ESM module, relative to the app root
      "drivers": ["hand_pose", "my-app/counter"], // started with the experience
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
    "kind": "camera-projector-surface", // a built-in kind, or your own with "experience"
    "required": true, // calibrate before the app starts
    "options": { "surfaceSize": { "width": 1920, "height": 1080 } },
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
  "network": {
    // origins beyond the defaults, see "Network access" below
    "connect": ["ws://relay.local:8080"],
  },
  "python": {
    // the app's own drivers, see "Python drivers" below
    "drivers": "python/my_app_drivers",
    "requirements": "python/requirements.txt", // optional
  },
}
```

`sdk` is a semver range of the `@gosai/sdk` versions your app works with,
usually `^` and the version you build against. GOSAI serves one SDK version to
app windows; it refuses to install an app whose range excludes that version and
lists an installed one as invalid, with the reason, in the dashboard. While the
SDK is `0.x`, `^0.1.0` means `>=0.1.0 <0.2.0`. A prerelease SDK counts as the
release it leads to: `0.2.0-rc.0` satisfies `^0.2.0`.

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
      state.hands = data.hands_landmarks.length;
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
succeeded), releases everything and shows the error. When the window closes
while `init` or `start` is still running, `rt.signal` aborts at once so the
hook can bail out, and the experience stops once the hook returns.

### Cleanup

When the experience stops, the runtime:

1. aborts `rt.signal` and removes every `rt.drivers.on` and `rt.events.on`
   subscription still open, so nothing fires into a stopping experience,
2. runs your `stop` hook, with the server connection still open for storage
   writes, logs and driver actions,
3. closes `rt.audio` and the server connection.

Pass `rt.signal` to anything else that accepts one:

```ts
window.addEventListener('keydown', onKey, { signal: rt.signal });
const res = await fetch(url, { signal: rt.signal });
```

Release other resources (WebGL renderers, media elements) in `stop`.

## Runtime context

| Member                                         | Description                                                                                                                              |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `rt.app.appSlug`, `rt.app.experienceSlug`      | Identity.                                                                                                                                |
| `rt.app.manifest`, `rt.app.experience`         | The parsed manifest and this experience's entry in it.                                                                                   |
| `rt.app.params`                                | Launch parameters of the window, such as `role` and `target` for calibration windows.                                                    |
| `rt.drivers.on(driver, event, listener)`       | Subscribe to a driver event, or to all of them with `'*'`. Returns `{ unsubscribe() }`. See [Driver data](#driver-data).                 |
| `rt.drivers.get(driver, event)`                | Latest value of a driver event, or `null` before the first one.                                                                          |
| `rt.drivers.execute(driver, action, params?)`  | Run a driver action and get its result.                                                                                                  |
| `rt.storage.get<T>(key, fallback?)`            | Read a JSON value. Returns `T` when you pass a fallback, `T \| undefined` otherwise.                                                     |
| `rt.storage.set(key, value)`, `remove`, `list` | Per-app key/value storage.                                                                                                               |
| `rt.settings.get<T>()`                         | Settings from the manifest schema: stored values merged over the defaults.                                                               |
| `rt.settings.set({ 'display.zoom': 2 })`       | Store settings by dotted key; `null` restores a default. Throws for undeclared keys and values that aren't strings, numbers or booleans. |
| `rt.assets.url(path)`                          | URL of a file in the app, relative to its root, e.g. `assets/a.png`.                                                                     |
| `rt.events.emit(topic, data)`, `rt.events.on`  | Messages to the app's other windows, e.g. from a projector to a control window.                                                          |
| `rt.log.debug/info/warn/error(message, data?)` | Logs shown in the dashboard's Logs panel.                                                                                                |
| `rt.audio`                                     | An `AudioContext` created on first use and resumed when the experience starts.                                                           |
| `rt.ping()`                                    | Round-trip time to the server, in milliseconds.                                                                                          |
| `rt.signal`                                    | Aborts when the experience stops.                                                                                                        |
| `rt.router.switchTo(slug)`, `rt.router.stop()` | Start or stop experiences of this app on the server. It doesn't open windows yet.                                                        |
| `rt.router.onStateChange(listener)`            | Follow the state of this app's experiences.                                                                                              |
| `rt.appConfig.get()`, `rt.appConfig.onChange`  | The app's device assignments (display, camera, microphone, speaker) and their changes.                                                   |
| `rt.app.server`                                | The raw server connection, for commands the SDK doesn't wrap.                                                                            |

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
- If `start` throws, the error goes to `onError` and the layer's `stop` hook
  still runs, the same rule as for experiences. A failing `create` or
  `preload` doesn't call `stop`.
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

Declare how the app is calibrated in its manifest's `calibration` object:

- `kind`: what the calibration produces. `camera-projector-surface` is built
  in: a camera watches a surface a projector draws on.
- `options`: settings of the kind. For `camera-projector-surface`:
  `surfaceSize`, `cornerLabels`, `stepCopy` and `projectorMessages`.
- `required`: the dashboard and kiosks calibrate the app before starting it.
- `experience`: one of your experiences that runs the flow instead of the
  built-in calibration app. Required for your own kinds.

GOSAI runs the flow from the dashboard's **Calibrate** button or on a kiosk's
first boot, and saves one profile for the app. Read it back:

```ts
import { loadCameraProjectorSurfaceCalibration } from '@gosai/sdk';

const calibration = await loadCameraProjectorSurfaceCalibration(rt); // null until calibrated
if (calibration?.surfaceQuadDisplay) applyQuadWarp(canvas, calibration.surfaceQuadDisplay);
```

`loadCalibrationProfile(rt, { kind })` returns the whole profile of any kind:
`{ version, kind, savedAt, data }`.
The server broadcasts `calibration:changed` with `{ appSlug, calibrated }`
after each save, so a running experience can reload it:
`rt.app.server.on('calibration:changed', reload)`.

### Custom flows

With `calibration.experience`, GOSAI starts that experience and opens it twice:
a control window and a fullscreen projector window. `readCalibrationLaunch(rt)`
tells them apart. The flow saves and then ends, and GOSAI closes both windows:

```ts
import { finishCalibration, readCalibrationLaunch, saveCalibrationProfile } from '@gosai/sdk';

const { role } = readCalibrationLaunch(rt); // 'control' or 'projector'
// ... once the operator is done, in the control window:
await saveCalibrationProfile(rt, { kind: 'acme-depth-grid', data: { grid } });
await finishCalibration(rt, { ok: true }); // or { ok: false, error, cancelled? }
```

Use `rt.events` with `CalibrationWizardTopics.Step` to keep the two windows in
step. Report failures with `finishCalibration` too, so the windows don't stay
open.

### From the earlier calibration API

Manifests in the earlier shape still load, with a deprecation warning in the
server log: `{ "required", "entry" }` calibrates as `camera-projector-surface`
without the options the entry module set, a `calibration` without `entry` is
ignored, and so is a custom `statusKey`.

| Before                                                                             | Now                                                          |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `calibration.entry` module with `createCameraProjectorSurfaceCalibration(options)` | `calibration.kind` and `calibration.options` in the manifest |
| `defineCalibration({ init, start, stop })`                                         | `calibration.experience`                                     |
| `calibration.statusKey`, `CALIBRATION_STATUS_KEY`, `CalibrationStatus`             | the profile, and `calibrated` from `calibration:get`         |
| `CAMERA_PROJECTOR_SURFACE_STORAGE_KEYS`                                            | `CALIBRATION_PROFILE_KEY`, one key                           |
| `loadCameraProjectorSurfaceCalibration(rt)` with `null` fields                     | the same call, returning the data or `null`                  |
| `CAMERA_PROJECTOR_SURFACE_CALIBRATION_KIND`                                        | `CalibrationKinds.CameraProjectorSurface`                    |
| `'pool-corners'` step                                                              | `'surface-corners'`                                          |

## Driver data

`rt.drivers` is typed from the drivers' schemas. The
[driver reference](https://github.com/IONIS-Institute-of-Technology/gosai/blob/master/docs/drivers.md)
lists every built-in driver with its events, actions and types.

```ts
rt.drivers.on('pose', 'raw_data', (data) => {
  data.body_pose; // number[][]
});

const marker = await rt.drivers.execute('calibration', 'render_marker', { id: 3, size: 200 });
marker.png_base64; // string

const latest = await rt.drivers.get('heartbeat', 'tick'); // null before the first tick
```

Misspelled events and actions and wrong params don't compile. The payload types are
exported as `DriverTypes`, e.g. `DriverTypes.pose.RawPosePayload`, and the
helpers `DriverEventData<'pose', 'raw_data'>`, `DriverActionParams` and
`DriverActionResult` name them from driver and event or action names.

A driver the SDK doesn't know still works, with `unknown` data. To type your
own drivers, generate a module augmentation from their schemas, the JSON that
`python -m gosai_py.schemas --app .` prints (see [Python drivers](#python-drivers))
or the server's `drivers:schema` reply:

```bash
bunx gosai-sdk gen-driver-types --schemas schemas.json --drivers my-app/counter \
  --out src/driver-types.ts --docs DRIVERS.md
```

The file adds `my-app/counter` to `DriverRegistry`, so
`rt.drivers.on('my-app/counter', ...)` is typed wherever the file is part of
your TypeScript project. `--drivers` picks drivers out of a larger list, such as
a `drivers:schema` reply. The `heartbeat`
driver ticks steadily and is handy for testing.

## Python drivers

An app can ship drivers of its own, written in Python like the built-in ones.
Put them in a package directory and name it in the manifest:

```
my-app/
├── gosai.app.json
└── python/
    ├── requirements.txt       optional
    └── my_app_drivers/
        ├── __init__.py
        └── counter.py
```

```jsonc
{
  "slug": "my-app",
  "python": {
    "drivers": "python/my_app_drivers", // its name must be a Python module name
    "requirements": "python/requirements.txt",
  },
  "experiences": [
    { "slug": "main", "name": "Main", "entry": "dist/main.js", "drivers": ["my-app/counter"] },
  ],
}
```

GOSAI imports the package and every module directly inside it, except names
starting with `_`, and runs each `BaseDriver` subclass defined there:

```python
from collections.abc import Mapping
from typing import ClassVar

import msgspec

from gosai_py import BaseDriver, DriverContext, Event, action


class Count(msgspec.Struct, kw_only=True):
    count: int


class CounterDriver(BaseDriver):
    name = "counter"
    description = "Counts up once a second."
    events: ClassVar[Mapping[str, Event]] = {"count": Event(Count, "The current count.")}
    loop_interval_s = 1.0

    def __init__(self, context: DriverContext) -> None:
        super().__init__(context)
        self._count = 0

    def loop(self) -> None:
        self._count += 1
        self.emit("count", Count(count=self._count))

    @action("Start counting again from `start`.")
    def reset(self, start: int) -> Count:
        self._count = start
        return Count(count=start)
```

The server names the driver `<app slug>/<name>`, here `my-app/counter`, so it
never collides with a built-in driver or another app's. Use that name
everywhere: in `drivers`, with `rt.drivers.on('my-app/counter', 'count', ...)`,
and in the dashboard's Drivers panel. Inside the package, `dependencies` and
`subscribe` use the plain names of the package's own drivers. Other apps may use
your drivers too, like built-in ones: each app gets its own instance of an
exclusive driver, and a `shared` driver has one instance for everyone.

**Process.** Your drivers run in a bridge process of their own, never in the
one that hosts the built-in drivers. When it crashes or stops answering, GOSAI
restarts it and starts the drivers your experiences still use, while built-in
drivers and other apps keep running. Leases, restarts, schemas and logs work as
for built-in drivers. A driver can only depend on drivers of the same package,
since other drivers run in other processes. To run a built-in driver in your
process, subclass it in your package; it then opens its own device. The process
gets `GOSAI_APP_SLUG`, `GOSAI_APP_DIR` and `GOSAI_APP_DATA_DIR` (the app's data
directory, which may not exist yet) in its environment.

**Environment.** Installing the app builds a Python environment for it with uv,
in `<GOSAI home>/python-envs/installed/<slug>/` (`builtin/<slug>/` for apps
bundled with GOSAI, built when the server starts). It is layered on GOSAI's own
environment: `gosai_py`, numpy, OpenCV, MediaPipe, ONNX Runtime and msgspec are
already importable. Never list `gosai-py` itself. uv installs your requirements
file on top. A package GOSAI's environment also has is pinned
to GOSAI's version, so a requirement that needs another version fails the
install with uv's explanation instead of breaking GOSAI's drivers. GOSAI builds
the environment again when the requirements file or its own environment
changes, for example after an update. An app with Python drivers can't be
installed when GOSAI has no Python runtime.

**Types.** Print the schemas of your drivers with GOSAI's Python, then generate
types as for any driver (see [Driver data](#driver-data)). From a GOSAI
checkout:

```bash
uv run --project <gosai>/python --with-requirements python/requirements.txt \
  python -m gosai_py.schemas --app . > schemas.json
bunx gosai-sdk gen-driver-types --schemas schemas.json --out src/driver-types.ts
```

Leave out `--with-requirements` without a requirements file. With an app
already installed, the environment GOSAI built works too:
`~/.gosai/python-envs/installed/my-app/.venv/bin/python -m gosai_py.schemas --app .`.
The generated types use the qualified names, so `rt.drivers.on('my-app/counter', 'count', ({ count }) => ...)`
is typed. The template in `templates/basic` has a counter driver to start from.

## Building

Bundle each entry as browser ESM and leave `@gosai/sdk` external:

```bash
bun build src/main.ts --target=browser --format=esm --outfile dist/main.js --external @gosai/sdk
```

GOSAI runs each app on its own origin, `http://<slug>.localhost:<port>`. The
page there has an import map that resolves `@gosai/sdk` to the server's copy
of the SDK under `/sdk/<version>/`, fetches your manifest, imports your entry
and runs it. The runtime checks that the server speaks the SDK's protocol
version and shows an error instead of starting when it doesn't. Files in
your app are served under `/v1/apps/<slug>/static/`; use `rt.assets.url` to
build their URLs.

### Content Security Policy

Everything served on an app origin carries a Content Security Policy:

- **Scripts** load only from the app origin (your bundle and the SDK) and
  other GOSAI app origins, and WebAssembly may compile. Bundle every script
  and `.wasm` file with your app: CDNs and inline scripts are blocked.
- **Styles, images, media and fonts** load from the app origin; images,
  media and fonts also from `data:` and `blob:` URLs. Inline `style`
  attributes written in HTML or with `setAttribute` are blocked; setting
  `element.style` properties from code works.
- **Connections** (`fetch`, `XMLHttpRequest`, `WebSocket`) may go to the app
  origin, `blob:` and `data:` URLs (loaders such as GLTF use them for
  embedded textures and model weights), and any `https:` or `wss:` URL.

Plain `http:` and `ws:` connections to other hosts are blocked by default,
since they would reach services on the machine or the local network. List the
ones your app needs in the manifest:

```json
"network": { "connect": ["ws://relay.local:8080", "http://192.168.1.20"] }
```

Each entry is a plain `scheme://host[:port]` origin with an `http`, `https`,
`ws` or `wss` scheme: no path, wildcard, quotes or spaces. The server refuses
a manifest with any other entry.

Blocked requests are logged through `rt.log` with the directive and URL, once
per URL, so they show up in the dashboard's Logs panel.
