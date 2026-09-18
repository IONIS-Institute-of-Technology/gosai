# GOSAI follow-up plan

Temporary file. It splits what the refresh (PRs 1 to 16) left open into PRs 17 to 21 for agents to implement. Delete it once the last PR merges.

The items come from the follow-ups noted during the refresh, checked against commit `f6e3b8b`. About two thirds of those notes were already fixed and are left out. File and line references point at `f6e3b8b`. Treat them as starting points and check the code before editing.

## How to use this file

1. Find your PR in the order table and check that everything it depends on has merged.
2. Read the rules, the decisions, and your PR's section.
3. Branch from the integration branch `t3code/plan-gosai-refresh` as `refresh/pr-NN-short-name`. Each PR merges back into it with a `Merge PR NN: <title>` commit.
4. Stay inside your PR's scope. If you find something that belongs to another PR, mention it in your PR description instead of fixing it.
5. Don't edit this file in an implementation PR.

## Rules for every PR

- GOSAI is a generic platform for AR products. `apps/interactive-pool`, `apps/second-self` and `apps/calibration` are bundled demos, not the full list of use cases.
- Don't remove a Python driver, driver option or action, server event, manifest capability or SDK export because the bundled apps don't use it. Remove platform code only when it is internal and nothing calls it, or when it is broken with no way to make it work.
- Demo apps import only the public `@gosai/sdk` entry. When a demo needs something the SDK lacks, add it to the SDK.
- Keep CI green, and add tests for what you fix.
- List every breaking SDK change under "Unreleased" in `packages/sdk/CHANGELOG.md`.

## Decisions already made

- `@gosai/sdk` has never been published. Breaking payload changes land now, before the first release: driver payload timestamps become milliseconds, and the redundant `ok: true` goes from driver results.
- When an experience crashes in a kiosk, the kiosk exits non-zero so its supervisor restarts it.
- The voice detection test downloads the real Silero model through the driver's own pinned URL and sha256, cached in CI. Only the audio clip is committed, with LFS.
- sign-training uses Aria's clip for every sign. Its four separate recordings go.
- No LayerManager menu API. Each demo keeps its own menu model, as `packages/sdk/src/layers.ts` intends.
- Running `dev:server` and `dev:desktop` separately stays as documented, with `GOSAI_DASHBOARD_TOKEN` set by hand.

## Order

| PR  | Title                                            | Depends on | Wave |
| --- | ------------------------------------------------ | ---------- | ---- |
| 17  | CI coverage and Python formatting                | none       | 1    |
| 18  | Driver payload conventions                       | 17         | 2    |
| 19  | Failures users can see                           | none       | 2    |
| 20  | Demo apps: calibration types, mirror kind, audio | 18         | 3    |
| 21  | Bundle size                                      | 20         | 3    |
|     | History rewrite                                  | see below  | any  |

Known overlaps:

- PRs 18 and 19 both add entries to `packages/sdk/CHANGELOG.md`.
- PR 18 changes `DriverTypes.calibration.*`, which PR 20 starts using in the calibration app.
- PR 20 deletes the four sign-training clips before PR 21 re-encodes the ones left.

---

## PR 17. CI coverage and Python formatting

Depends on: none. Wave 1. Small. It goes first because the formatting churn would conflict with PR 18.

### Scope

- Run `ruff format` on `python/` and on `training/`, one commit each, with no other change in those commits.
- Add `ruff format --check .` to the Python and Training CI jobs and to the root `python:check` script.
- Give the JS CI job uv and `python/.venv` (`setup-uv`, then `uv sync --locked` in `python/`), so the server tests that need the bridge run in CI.
- App builds empty `dist/` before writing to it, in the three apps and `templates/basic`.

### Evidence

- `ruff format --check` with ruff 0.16.8 would reformat 31 files in `python/` and 14 in `training/`. `.github/workflows/ci.yml:99,117` only run `ruff check`, and `package.json` `python:check` has no format step.
- The JS job (`ci.yml:17-31`) has no venv, so these skip in CI:
  - `packages/server/test/bridge-contract.test.ts:36`: the Python bridge contract.
  - `bridge-contract.test.ts:152`: the app driver bridge contract, which also needs uv.
  - `packages/server/test/python-env.test.ts:212`.
- `apps/*/package.json` `build` runs `bun build --outdir dist` without cleaning it. `apps/interactive-pool/dist/calibration.js` is a leftover of an older build, and `packages/desktop/electron-builder.config.cjs:98` and `scripts/package-kiosk.ts:191` copy the whole app directory, so it ships.

---

## PR 18. Driver payload conventions

Depends on: PR 17. Wave 2. Python, the generated SDK types and the changelog.

### Scope

- Timestamps.
  - Every timestamp in a driver payload (`ts`, `capture_ts`) is in milliseconds since the Unix epoch, like the bridge envelope. Use one helper, shared with the bridge's `now_ms()`.
  - Update in-driver math that reads these fields, such as capture latency.
  - Say "milliseconds" in the schema descriptions.
- `ok` in results.
  - Remove the `ok` field from driver result structs, `SizeResult` included, and delete the `Ok` type in `payloads.py`. Actions that returned `Ok()` return nothing.
  - Make the camera and audio device lists the same shape.
- Event delivery. Write the rule into the `BaseDriver` docstring: an event that carries a new state every frame or window goes in `stream_events` (latest value only), and a discrete event is queued. Then apply it:
  - Add `speech_activity_detection.activity`, `slr.new_sign` and `interpolate.interpolated_data` to `stream_events`.
  - `speaker.underrun` leaves the audio callback. Emit it from a worker, at most once a second, with a count.
- Voice detection.
  - `predict` gets its own recurrent state and emits no `activity` events, so offline audio can't disturb the live stream.
  - Add a test that runs the real Silero model over a recorded clip of speech then silence, and checks where speech starts and ends.
  - The test resolves the model with `resolve_model(MODEL, ...)`, with `GOSAI_HOME` pointing at a directory CI caches with `actions/cache`, keyed on the model's sha256. It skips when offline, except when `CI` is set.
  - Commit the clip with LFS: add `*.wav` to `.gitattributes` and add the clip to the `git lfs pull` include list in CI. Use a clip you recorded or one with a clear license.
- `_letterbox`: add a golden-value test on each side, with the same input and the same expected output. Training doesn't depend on `gosai_py`, so don't share the code.
- Regenerate `packages/sdk/src/drivers.generated.ts` and `docs/drivers.md`, and add the changelog entries.

### Evidence

Paths are relative to `python/src/gosai_py/` unless noted.

- `packages/shared/src/protocol.ts:78` says every `ts` is milliseconds, and `bridge.py:87` has `now_ms()`. Payloads use `time.time()`, which is in seconds:
  - `drivers/camera.py:437,443`
  - `drivers/microphone.py:157`
  - `drivers/speech_activity_detection.py:194`
  - `drivers/pose.py:181`
  - `drivers/hand_pose.py:202`
  - `drivers/hand_sign.py:66`
  - `drivers/ball.py:503`
  - `drivers/calibration.py:219,279`
  - `drivers/speech_to_text.py:129`
  - `drivers/speaker.py:199`
  - `drivers/pose_to_mirror.py:333`

  Only a comment at `drivers/camera.py:71` mentions seconds. No bundled app reads `ts`.

- `ok`:
  - `payloads.py:18-19` define `Ok`, which holds only `ok`. `SizeResult` at `:27-30` also carries `ok`.
  - About 17 result structs declare `ok: bool = True`: camera, hand_pose, five in calibration, speech_to_text, interpolate, microphone, three in pose_to_mirror, two in speaker, and speech_activity_detection.
  - `bridge.py:670` adds `"ok": True` to the audio device list, while the camera list at `:663` has none.
  - The reply envelope already carries `ok` (`bridge.py:508`). No app reads a driver result's `ok`.
- Delivery settings live in `driver.py:184-210,327-364`. `hand_sign.sign` and `frequency_analysis.frequency` are latest-only, while these aren't:
  - `speech_activity_detection.activity`: once per 512-sample window, about 31 a second.
  - `slr.new_sign`: once per pose frame after the first 30 (`drivers/slr.py:190`).
  - `interpolate.interpolated_data`: once per step (`drivers/interpolate.py:112`).
  - `speaker.underrun`: once per audio callback while underflowing, on the audio thread (`drivers/speaker.py:197-199`).
- `drivers/speech_activity_detection.py:162-165`: `predict` feeds the live model state and emits `activity`. The model is `Model.download` with a pinned URL and sha256 at `:29-37`, and `runtime/models.py:64-67` puts downloads under `GOSAI_HOME`. `python/tests/test_speech_devices.py` only uses `FakeSileroSession`.
- `_letterbox` exists in `drivers/ball.py:91` and `training/src/gosai_train/pipelines/yolo_detect/export.py:29`. The ball version also returns the scale and padding.

---

## PR 19. Failures users can see

Depends on: none. Wave 2. Server, SDK runtime and desktop.

### Scope

- Python unavailable.
  - Boot passes the reason Python setup failed to the server.
  - When the built-in bridge never started, every driver call rejects with "Python drivers are unavailable: <reason>": start, subscribe, execute, get-data and schema. Without a setup failure, the reason names the missing environment and says to run `uv sync`.
  - The dashboard shows the reason in the status bar. The kiosk shows it on screen when its experience fails to start, not only in the console.
- Fatal render stop.
  - `experience:stop` takes an optional `error`. The server then marks the experience `crashed` instead of `idle` and logs the error.
  - `RunningExperience` gets an optional `error`. The server also sets it when a start fails.
  - The runtime sends it after repeated render failures, as a best effort when the stop comes from a protocol mismatch.
  - Main already closes the windows of a crashed experience, and a kiosk already exits with 1 when its experience crashes. Add a test that covers the whole path.
  - The dashboard shows the error on the app's row.
- Load the dashboard from a custom protocol, so the server's origin allowlist can drop `file://` and `null`. If this grows beyond a small change, leave it out and say so in the PR.
- Cleanups:
  - Delete the unused `AppPolicyOptions.port`.
  - Fix the comment in `static-files.ts`, which still says app data lives in the install directory.
  - Keep one `bridgeExecutable`, in `@gosai/shared`.

### Evidence

Paths are relative to `packages/` unless noted.

- `desktop/src/main/boot.ts:72-79` catches the setup failure and hands the server the bundled Python folder, which has no venv. The comment says "the server reports a clear error". `server/src/server.ts:90-93` only sees that the bridge executable is missing, and `:117` logs at info level.
- Starting an experience fails with "Python bridge is not running" (`server/src/drivers/manager.ts:471`). Execute, get-data and schema look the driver up first and fail with "Unknown driver: pose" (`server/src/drivers/hub.ts:374`).
- In a kiosk, a failed start is only logged (`desktop/src/main/kiosk.ts:145-156,215`).
- `sdk/src/runtime.ts:297-300` stops locally after 60 consecutive render failures, and `sdk/src/app-host-page.ts:132` shows an error panel. The server still reports `running`.
  - `desktop/src/main/experience-windows.ts:15` closes windows on `crashed`.
  - `desktop/src/main/kiosk-lifecycle.ts:58-82` exits with 1 when the kiosk's experience crashes and nothing starts after it.
  - `shared/src/types.ts:288` `RunningExperience` has no error field.
  - `shared/src/protocol-schemas.ts:136` `experience:stop` takes only the slugs.
  - `server/src/apps/manager.ts:417` marks a failed start `crashed` without keeping the reason.
- `desktop/src/main/server-runner.ts:43` allows `file://` and `null` for the dashboard. App windows already run on their own origins.
- `server/src/apps/app-host.ts:38-39` declares `port`, which `appContentSecurityPolicy` no longer reads, and `server/src/http/routes.ts:53` still passes it.
- `server/src/apps/static-files.ts:4-8`: data moved to `paths.data/<slug>` (`server/src/apps/data-migration.ts`). Keep blocking `_data` and `_config`, since installs from before the migration may still have them.
- `bridgeExecutable` is written twice: `server/src/drivers/bridge.ts:442` and `desktop/src/main/python-runtime.ts:148`.

---

## PR 20. Demo apps: calibration types, mirror calibration kind, audio

Depends on: PR 18. Wave 3. The second-self calibration move can be its own PR.

### Scope

- Calibration app.
  - Use the generated driver types for camera frames, marker images and compute results. Delete the casts and the local `MarkerImage` and `ComputeResult`.
  - Stop passing explicit type arguments to `execute`, which selects the deprecated overloads. Keep those overloads in the SDK for third-party apps until 1.0.
- second-self mirror calibration becomes a custom calibration kind.
  - Add a calibration experience and a manifest `calibration: { kind, experience }` block.
  - Save through the SDK profile helpers, with a reader for the current `mirror_calibration` storage key so existing installs keep their calibration.
  - The menu entry switches to the calibration experience with `rt.router.switchTo`, so kiosks still reach it.
  - The dashboard's Calibrate button and kiosk calibration then work for second-self.
- `requirements.speaker`.
  - Say in the manifest schema description and the SDK README that it assigns the device of the Python `speaker` driver, and that browser audio (`rt.audio`) plays on the system output.
  - Regenerate the JSON Schema. Remove `speaker` from second-self's manifest, since it doesn't use that driver.
- sign-training plays Aria's clip for every sign.
  - Delete `TRAINING_VIDEOS` and the four files in `assets/sign-training/videos/`.
  - Update the README if it mentions them.

### Evidence

Paths are relative to `apps/` unless noted.

- `calibration/src/control.ts:128,138` and `calibration/src/projector.ts:153` cast driver payloads. `projector.ts:36-38` declares `MarkerImage`, and `calibration/src/wizard.ts:138-149` copies `DriverTypes.calibration.ComputeResult`. `control.ts:199` and `projector.ts:91` call `execute<T>`.
- `second-self/src/layers/calibrate.ts` is 681 lines. It is registered at `second-self/src/main.ts:97` and starts on its own without a profile at `:291-294`, and the menu keeps it on purpose (`:93-95`).
  - It stores the profile under `mirror_calibration` (`second-self/src/shared/config.ts:18`, `second-self/src/shared/projection.ts:85-91`).
  - Custom kinds exist (`packages/shared/src/calibration.ts:58`, SDK README `:65`), and no bundled app uses one.
- `requirements.speaker` only reaches the dashboard picker (`packages/desktop/src/renderer/src/dashboard/panels/apps/DeviceSettingsSection.tsx:136-143`) and the Python speaker driver (`packages/server/src/drivers/camera-config.ts:60`). Nothing calls `setSinkId`.
  - second-self declares it (`second-self/gosai.app.json:10`) but plays its synth through `rt.audio`, and its videos are muted.
  - interactive-pool declares nothing and plays sounds through `rt.audio`, which is correct under this rule.
- `second-self/src/layers/sign-training.ts:40-44,118-123`: hello, left, ok and right use `sign-training/videos/`, the other ten use `signs/Aria/`. So one training session shows three teachers:
  - `hello` is a different 3D avatar.
  - `left`, `ok` and `right` show a real person, with what looks like a watermark in the bottom corner.
  - Every other sign shows Aria.

---

## PR 21. Bundle size

Depends on: PR 20. Wave 3. An asset PR: judge the result on screen, not only by size.

### Scope

- Re-encode `apps/second-self/assets/signs/Aria/`.
  - Drop the audio track and lower the resolution.
  - Try cropping around Aria. She fills about two thirds of the frame height, with empty grey space on both sides.
  - Pick the size and quality by looking at sign-game and sign-training on a projector-sized window.
- Check the other second-self folders (`aria/`, `sign-game/`, `dance/`) for the same easy wins. Don't touch files whose loading code depends on their format.
- Not worth doing: excluding apps' `src/` and `test/` from the bundle, which saves about 0.5 MB.

### Evidence

- second-self is 176 MB of the 177 MB of bundled apps:
  - `signs/` is 133 MB.
  - `aria/` and `sign-game/` are 16 MB each.
  - `dance/` is 7.9 MB.
- The Aria clips are 1920x1080 VP9 with an Opus track. `second-self/src/shared/media.ts:69` plays them muted.
- sign-game fits them into boxes with `drawContain` (`second-self/src/layers/sign-game.ts:264,330`), and sign-training draws them 600 px wide (`second-self/src/layers/sign-training.ts:246`), so a crop changes both layers' look.

---

## History rewrite, after PR 21

The rewrite planned between waves 1 and 2 never ran: the pack is still 415 MB. Most of that is raw blobs committed before `.gitattributes` existed. The PR 2 list is at `/workspaces/worktrees/gosai/pr-02-deleted-paths.txt` (462 entries).

- The Aria clips have been LFS objects since `ec6e4fb`, so history holds only their pointers. Re-encoding them in PR 21 doesn't change the pack.
- Stripping the old clips' pointers matters only if the GitHub repository gets recreated to free LFS storage, since GitHub keeps orphaned LFS objects otherwise. In that case, run the rewrite after PR 21 and remove the old pointers by blob id with `git filter-repo --strip-blobs-with-ids`, next to `--invert-paths --paths-from-file` for the PR 2 list. The recreated repository then never receives 133 MB of old clips.
- 24 entries of the PR 2 list have identical content at HEAD under `signs/Aria/`. Check that the rewrite keeps HEAD's files, and compare `git ls-tree -r HEAD` before and after.
- Then follow the original steps: `git lfs migrate import`, verify, force-push, and everyone re-clones.
