# Changelog

Changes to `@gosai/sdk`. Versions follow [semver](https://semver.org); while the
SDK is `0.x`, a minor version may break the API. Pushing an `sdk-v<version>` tag
publishes the version to npm with the section below as its release notes.

## 0.1.0

First public release.

- `@gosai/sdk`: `defineExperience`, the runtime context types, layers, canvas,
  warp, homography and calibration helpers, and the errors requests reject with.
- `@gosai/sdk/host`: `runExperience`, `ServerClient` and the protocol constants,
  for code that hosts experiences.
- Bundled type declarations with no runtime dependencies.
- `@gosai/sdk/gosai.app.schema.json`: the manifest JSON Schema.
