# Changelog

Changes to `@gosai/sdk`. Versions follow [semver](https://semver.org); while the
SDK is `0.x`, a minor version may break the API. Pushing an `sdk-v<version>` tag
publishes the version to npm with the section below as its release notes. The
Release SDK workflow needs an `NPM_TOKEN` secret; see
`.github/workflows/release-sdk.yml`.

## Unreleased

Breaking:

- `DriverTypes.calibration.ReprojectedPoints.points` is `(null | Point)[]`. The
  calibration driver's `reproject_points` returns `null` for a point that maps
  to infinity, where it used to return (0, 0).
- `rt.drivers.execute('calibration', 'reproject_point', ...)` rejects for a
  point that maps to infinity, where it used to resolve with (0, 0).
- `fitCanvas`, and so `createFullscreenCanvas().fit()`, sizes the backing store
  from the canvas box before CSS transforms, under any transform. With a
  transform such as a warp from `applyQuadWarp`, a scale or a rotation, it used
  to take the size of the transformed bounding box.
- `gosai.app.schema.json` drops the placeholder `python.module` and
  per-experience `python` fields, and `python` requires `drivers`. GOSAI still
  loads manifests with the old fields and ignores them with a warning.
- Timestamps in built-in driver payloads are milliseconds since the Unix epoch,
  like `Date.now()`. They were seconds. This covers every `ts` and
  `capture_ts`, `heartbeat.tick`'s `now`, and `camera.frame`'s `capture_perf`,
  which stays a clock of the bridge process but now counts milliseconds too.
- Built-in driver results no longer carry `ok: true`. A failed action already
  rejects. Actions with nothing to report resolve with `null`:
  `ball.set_homography`, `calibration.clear`, `interpolate.reset`,
  `slr.set_actions`, `speaker.clear` and `speech_activity_detection.reset`.
  The `DriverTypes.<driver>.Ok` types are gone, and
  `speech_to_text.transcribe` returns
  `DriverTypes.speech_to_text.TranscriptionPayload` instead of
  `TranscribeResult`.
- `speech_activity_detection.activity` and `slr.new_sign` keep only the
  latest value, like the other events sent every frame or audio window: an app
  that reads slower than the driver emits gets the newest value and misses the
  ones before it.
- `speaker.underrun` comes at most once a second, with `count`, the number of
  underruns since the previous event. It used to come once per starved audio
  block.
- `speech_activity_detection.predict` scores from a fresh model state on each
  call and no longer emits `activity`, so offline audio can't disturb the live
  microphone stream. `reset` clears only the live stream's state.

Added:

- `rt.settings.onChange(listener)` follows changes to the app's settings, for
  example from the dashboard, including changes made while the connection was
  down: a reconnect reloads the settings. The runtime removes the listener when
  the experience stops.
- Apps can ship Python drivers: the manifest's `python.drivers` names the
  package and `python.requirements` its requirements file. They run in their
  own process and Python environment, named `<app slug>/<driver>`.
- `gosai-sdk gen-driver-types` accepts app driver names such as
  `my-app/counter`, from `python -m gosai_py.schemas --app <dir>`.
- Experience states from `rt.router.onStateChange` carry `startedAs`:
  `request` for the experience a client asked for, `requirement` for one that
  only runs because another lists it in `required`. The desktop app and kiosks
  open windows for requested experiences only.
- The desktop app and kiosks open and close windows as experiences start and
  stop, so `rt.router.switchTo` replaces the app's window with the next
  experience's.
- `readCalibrationLaunch(rt).managed` tells a calibration window GOSAI opened,
  which waits for `finishCalibration`, from a calibration experience the app
  started itself, for example with `rt.router.switchTo` from its own menu.

## 0.1.0

First public release.

- `@gosai/sdk`: `defineExperience`, the runtime context types, layers, canvas,
  warp, homography and calibration helpers, and the errors requests reject with.
- `@gosai/sdk/host`: `runExperience`, `ServerClient` and the protocol constants,
  for code that hosts experiences.
- `rt.drivers` types the events, params and results of the built-in drivers,
  and `gosai-sdk gen-driver-types` generates the same types for an app's own
  drivers.
- `rt.drivers.get<T>(driver, event)` and `rt.drivers.execute<T>(driver, action, data)`
  still compile but are deprecated: with a type argument they only cast. For a
  built-in driver, drop the type argument and the result is typed. For your own
  drivers, run `gosai-sdk gen-driver-types` on their schemas and do the same.
  `get` now returns `null` before the first event.
- Manifests declare the SDK versions they work with in `sdk`, and the runtime
  refuses a server that speaks another protocol version.
- Bundled type declarations with no runtime dependencies.
- `@gosai/sdk/gosai.app.schema.json`: the manifest JSON Schema.
