# Changelog

Changes to `@gosai/sdk`. Versions follow [semver](https://semver.org); while the
SDK is `0.x`, a minor version may break the API. Pushing an `sdk-v<version>` tag
publishes the version to npm with the section below as its release notes. The
Release SDK workflow needs an `NPM_TOKEN` secret; see
`.github/workflows/release-sdk.yml`.

## Unreleased

- `rt.settings.onChange(listener)` follows changes to the app's settings, for
  example from the dashboard. The runtime removes the listener when the
  experience stops.
- `fitCanvas`, and so `createFullscreenCanvas().fit()`, sizes the backing store
  from the canvas box before CSS transforms. A canvas warped with
  `applyQuadWarp` used to get the size of the warped quad's bounding box.

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
